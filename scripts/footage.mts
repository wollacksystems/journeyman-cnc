/**
 * Brag-footage round trip: the source of truth for the 20-second Journeyman
 * launch video (wollacksystems/journeyman#29).
 *
 *   npm run footage -- capture              # render the corpus at production scale
 *   npm run footage -- bundle               # validate + write the published index
 *   npm run footage -- publish [--tag t]    # gh release create/upload from the bundle
 *   npm run footage -- fetch [--tag t]      # download + checksum-verify into renders/
 *
 * Why this exists: `npm run smoke` captures 640x360 preview composites for PR
 * embeds, and the release `preview-corpus-v1` publishes exactly those. The brag
 * needs the locked production size (1920x1080) per production camera, four
 * angles per scenario, as *valid* MP4s — the 2026-09-14 batch left atc-jam's
 * clips as 0-byte stubs because the driver closed the browser before the
 * download streams drained, and nothing checked the files it had "produced".
 *
 * So the contract here is:
 *   - capture produces `scripts/footage-artifacts/renders/<scenario>/<camera>.mp4`
 *     at the production scale, and *validates* every file (ftyp + moov + size)
 *     instead of trusting the on-page status line;
 *   - bundle refuses to ship anything that is not production quality unless
 *     `--allow-preview`, so a 360p smoke run can never masquerade as the corpus
 *     the video is cut from;
 *   - publish puts the clips + `footage.json` (sha256 per file, plus the beat
 *     and narration timeline) on a GitHub release, which any consumer — the
 *     video build, the ingest pipeline, the marketing site — can fetch over
 *     plain HTTPS without auth or a local checkout;
 *   - fetch downloads that index into the gitignored `renders/` layout the
 *     editor expects and verifies every byte against its recorded sha256.
 *
 * Usage: npm run footage -- <capture|bundle|publish|fetch> [flags]
 * Requires Node 23.6+ and, for capture, `npm run dev` (no `--mode smoke`) plus
 * a Playwright-managed Chromium (`npx playwright-core install chromium`).
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  formatBytes,
  launchCaptureBrowser,
  loadScenarioFixtures,
  PRODUCTION_HEIGHT,
  PRODUCTION_WIDTH,
  startCaptureServer,
  trackDownloads,
  type ScenarioFixture,
} from "./lib/capture-driver.mts";

const REPO = process.env.FOOTAGE_REPO ?? "wollacksystems/journeyman-cnc";
const TAG = process.env.FOOTAGE_TAG ?? "footage-corpus-v1";
const ARTIFACTS = process.env.FOOTAGE_OUT ?? join("scripts", "footage-artifacts");
const RENDERS = join(ARTIFACTS, "renders");
const BUNDLE_DIR = join(ARTIFACTS, "bundle");
const INDEX_FILE = join(BUNDLE_DIR, "footage.json");
const LOCK_FILE = join(ARTIFACTS, "footage.lock.json");
/** Only used when the caller points the capture at an existing dev server. */
const BASE_URL = process.env.FOOTAGE_URL;
const STATUS = "#capture-status";
const DONE_PREFIX = "saved renders/";

/** Floor for "this is a real clip, not a stubbed download" (a 1080p clip is MBs). */
const MIN_CLIP_BYTES = 64 * 1024;
/**
 * The app's boot line. Nothing writes it mid-run, so reading it after the batch
 * started means the page loaded a fresh document (a dev-server reload), which
 * resets the sim clock and abandons the batch — abort immediately instead of
 * burning the stall timeout, and say what actually happened.
 */
const BOOT_STATUS = "idle";
/**
 * Ceiling on a single `#capture-status` read. Playwright's own timeout is not
 * enough: a wedged renderer can hang one protocol call far past it, and the
 * driver cannot report the stall it is blocked on. On 2026-09-24 the poll loop
 * went silent for 56 minutes inside one such read, so every read is now raced
 * against the wall clock too.
 */
const STATUS_READ_MS = Number(process.env.FOOTAGE_STATUS_READ_MS ?? 45_000);
/** Cameras one page load may render before the retry loop re-plans (see capUnits). */
const CAMERAS_PER_ATTEMPT = Math.max(1, Number(process.env.FOOTAGE_CAMERAS_PER_ATTEMPT ?? 4));
/** Status stall watchdog, and the whole-run ceiling (3 scenarios at 1080p is slow). */
const STALL_MS = Number(process.env.FOOTAGE_STALL_MS ?? 300_000);
const HARD_TIMEOUT_MS = Number(process.env.FOOTAGE_TIMEOUT_MS ?? 3_600_000);

type Quality = "production" | "preview";
type Command = "capture" | "bundle" | "publish" | "fetch";

const log: string[] = [];

function say(line: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  const msg = `[${ts}] ${line}`;
  log.push(msg);
  process.stdout.write(msg + "\n");
}

function fail(message: string): never {
  say(`FAIL: ${message}`);
  throw new Error(message);
}

/**
 * Await `work`, but give up after `ms` so one hung protocol call cannot block
 * the driver's whole poll loop.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Blocking sleep — the publish path is synchronous, so there is nothing to yield to. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function saveLog(name: string): void {
  try {
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, name), log.join("\n") + "\n");
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// index shapes (the published contract)
// ---------------------------------------------------------------------------

interface ClipRecord {
  camera: string;
  file: string;
  asset: string;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  durationSec: number;
}

interface ScenarioRecord {
  id: string;
  title: string;
  role: string;
  durationSec: number;
  fps: number;
  lesson: { title: string; body: string };
  beats: Array<{ id: string; label: string; tStart: number; tEnd: number; cameraHint: string }>;
  narration: Array<{ t: number; text: string }>;
  manifestFile: string;
  manifestAsset: string;
  /**
   * Checksum of manifest.json. The manifest is what carries the beat and
   * narration timeline downstream edit and ingest tools cut against, so it is
   * the one file a silent swap or truncation would poison without invalidating
   * any clip hash. Optional so indexes published before it existed still read.
   */
  manifestSha256?: string;
  manifestBytes?: number;
  clips: ClipRecord[];
}

interface FootageIndex {
  index: "journeyman-footage";
  indexVersion: 1;
  generatedUtc: string;
  repo: string;
  tag: string;
  commit: string | null;
  worktreeClean: boolean;
  engineVersion: string;
  quality: Quality;
  capture: { width: number; height: number; fps: number };
  totals: { scenarios: number; clips: number; bytes: number };
  scenarios: ScenarioRecord[];
}

interface CaptureManifest {
  capture?: {
    engineVersion?: string;
    scenario?: { id?: string; title?: string; role?: string };
    sim?: { fps?: number; durationSec?: number };
  };
  cameras?: Array<{ id?: string; width?: number; height?: number }>;
  timeline?: {
    beats?: ScenarioRecord["beats"];
    narration?: ScenarioRecord["narration"];
  };
  lesson?: { title?: string; body?: string };
}

// ---------------------------------------------------------------------------
// file helpers
// ---------------------------------------------------------------------------

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * A downloaded MP4 is only real if it carries the file-type box up front and a
 * movie box somewhere — the exact check that catches 0-byte stubs and truncated
 * streams from a canceled download.
 */
function invalidMp4Reason(path: string): string | null {
  const buf = readFileSync(path);
  if (buf.length < MIN_CLIP_BYTES) return `only ${formatBytes(buf.length)}`;
  if (!buf.subarray(0, 16).includes("ftyp")) return "no ftyp box";
  if (buf.indexOf("moov") < 0) return "no moov box (truncated mux)";
  return null;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function assetName(scenarioId: string, camera: string): string {
  return `journeyman-${scenarioId}-${camera}.mp4`;
}

function manifestAssetName(scenarioId: string): string {
  return `journeyman-${scenarioId}-manifest.json`;
}

function releaseBase(tag: string, repo: string): string {
  return `https://github.com/${repo}/releases/download/${tag}`;
}

function gitState(): { commit: string | null; clean: boolean } {
  const rev = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  return {
    commit: rev.status === 0 ? rev.stdout.trim() : null,
    clean: status.status === 0 ? status.stdout.trim() === "" : false,
  };
}

// ---------------------------------------------------------------------------
// validation (shared by capture, bundle, fetch)
// ---------------------------------------------------------------------------

interface Validation {
  scenarios: ScenarioRecord[];
  quality: Quality;
  problems: string[];
}

/**
 * Check a renders directory against the storyboard fixtures: every scenario and
 * production camera present, every clip a valid MP4, every manifest agreeing
 * with the fixture on duration/fps and declaring the captured scale.
 */
function validateRenders(rendersRoot: string, fixtures: ScenarioFixture[]): Validation {
  const problems: string[] = [];
  const scenarios: ScenarioRecord[] = [];
  let declaredScale: { width: number; height: number } | null = null;
  let quality: Quality = "production";

  for (const fixture of fixtures) {
    const dir = join(rendersRoot, fixture.scenarioId);
    const manifestPath = join(dir, "manifest.json");
    let manifest: CaptureManifest | null = null;
    if (!existsSync(manifestPath)) {
      problems.push(`${fixture.scenarioId}: missing manifest.json`);
    } else {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CaptureManifest;
      } catch (err) {
        problems.push(`${fixture.scenarioId}: manifest.json unreadable (${String(err)})`);
      }
    }

    const captureScale = {
      width: manifest?.cameras?.[0]?.width ?? 0,
      height: manifest?.cameras?.[0]?.height ?? 0,
    };
    if (manifest) {
      const sim = manifest.capture?.sim;
      if (sim?.durationSec !== fixture.durationSec || sim.fps !== fixture.fps) {
        problems.push(
          `${fixture.scenarioId}: manifest sim ${sim?.durationSec}s@${sim?.fps}fps ` +
            `!= fixture ${fixture.durationSec}s@${fixture.fps}fps`,
        );
      }
      const mismatched = (manifest.cameras ?? []).filter(
        (c) => c.width !== captureScale.width || c.height !== captureScale.height,
      );
      if (mismatched.length > 0) {
        problems.push(`${fixture.scenarioId}: manifest cameras disagree on capture size`);
      }
      if (captureScale.height > 0 && captureScale.height < PRODUCTION_HEIGHT) quality = "preview";
      if (declaredScale && declaredScale.height !== captureScale.height) {
        problems.push(
          `${fixture.scenarioId}: capture size ${captureScale.width}x${captureScale.height} ` +
            `!= ${declaredScale.width}x${declaredScale.height} (mixed scales in one corpus)`,
        );
      }
      declaredScale = captureScale;
    }

    const clips: ClipRecord[] = [];
    for (const camera of fixture.cameras) {
      const file = `renders/${fixture.scenarioId}/${camera}.mp4`;
      const path = join(rendersRoot, fixture.scenarioId, `${camera}.mp4`);
      if (!existsSync(path)) {
        problems.push(`${fixture.scenarioId}/${camera}: missing ${file}`);
        continue;
      }
      const invalid = invalidMp4Reason(path);
      if (invalid) {
        problems.push(`${fixture.scenarioId}/${camera}: unusable clip (${invalid})`);
        continue;
      }
      const bytes = statSync(path).size;
      clips.push({
        camera,
        file,
        asset: assetName(fixture.scenarioId, camera),
        bytes,
        sha256: sha256File(path),
        width: captureScale.width,
        height: captureScale.height,
        durationSec: fixture.durationSec,
      });
    }

    scenarios.push({
      id: fixture.scenarioId,
      title: manifest?.capture?.scenario?.title ?? "",
      role: manifest?.capture?.scenario?.role ?? "",
      durationSec: fixture.durationSec,
      fps: fixture.fps,
      lesson: manifest?.lesson ?? fixture.lesson,
      beats: manifest?.timeline?.beats ?? fixture.beats.map((b) => ({ ...b, label: b.id })),
      narration: manifest?.timeline?.narration ?? fixture.narration,
      manifestFile: `renders/${fixture.scenarioId}/manifest.json`,
      manifestAsset: manifestAssetName(fixture.scenarioId),
      // Only when present: a missing manifest is already a validation problem,
      // so a rejected render set never reaches the index either way.
      ...(existsSync(manifestPath)
        ? {
            manifestSha256: sha256File(manifestPath),
            manifestBytes: statSync(manifestPath).size,
          }
        : {}),
      clips,
    });
  }

  return { scenarios, quality, problems };
}

function requireClean(validation: Validation, allowPreview: boolean): void {
  if (validation.problems.length > 0) {
    say("render set rejected:");
    for (const problem of validation.problems) say(`  - ${problem}`);
    fail(`${validation.problems.length} problem(s) in ${RENDERS}`);
  }
  if (validation.quality !== "production" && !allowPreview) {
    const scale = validation.scenarios[0]?.clips[0];
    fail(
      `captured at ${scale?.width ?? "?"}x${scale?.height ?? "?"} — footage ships at ` +
        `${PRODUCTION_WIDTH}x${PRODUCTION_HEIGHT}. Start the dev server without ` +
        `\`--mode smoke\` (plain \`npm run dev\`) and re-run capture, or pass --allow-preview ` +
        `to accept preview quality explicitly.`,
    );
  }
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

interface CaptureOptions {
  /** Target an existing dev server; when absent the driver starts its own. */
  url?: string;
  allowPreview: boolean;
  timeoutMs: number;
}

/** One scenario's worth of cameras, the unit a batch is scoped to. */
interface CaptureUnit {
  scenarioId: string;
  cameras: string[];
}

interface AttemptOutcome {
  downloads: number;
  scale: string;
}

/**
 * What is still owed, read from the render directory itself. A scenario counts
 * as done only when its clips *and* its manifest validate at production scale;
 * anything less becomes work. A scenario whose clips are all valid but whose
 * manifest is missing has to be rendered whole again — the batch writes both
 * together, so there is no smaller unit to redo.
 */
function planRemaining(
  fixtures: ScenarioFixture[],
  allowPreview: boolean,
): { done: string[]; units: CaptureUnit[] } {
  const done: string[] = [];
  const units: CaptureUnit[] = [];

  for (const fixture of fixtures) {
    const validation = validateRenders(RENDERS, [fixture]);
    // Scale is part of completeness: a production run must not treat leftover
    // preview renders as done (requireClean would reject them afterwards), and
    // a --allow-preview proof must not re-render everything it just produced.
    const complete =
      validation.problems.length === 0 &&
      (allowPreview || validation.quality === "production") &&
      (validation.scenarios[0]?.clips.length ?? 0) === fixture.cameras.length;
    if (complete) {
      done.push(fixture.scenarioId);
      continue;
    }
    const owed = fixture.cameras.filter((camera) => {
      const path = join(RENDERS, fixture.scenarioId, `${camera}.mp4`);
      return !existsSync(path) || invalidMp4Reason(path) !== null;
    });
    units.push({
      scenarioId: fixture.scenarioId,
      cameras: owed.length > 0 ? owed : [...fixture.cameras],
    });
  }

  return { done, units };
}

/**
 * Drop the renders a unit is about to redo. Chromium de-duplicates a repeated
 * download name with " (1)", which `structuredPath` would faithfully preserve
 * as a stray file the bundle then rejects.
 */
function clearUnitRenders(fixture: ScenarioFixture, unit: CaptureUnit): void {
  const dir = join(RENDERS, unit.scenarioId);
  if (unit.cameras.length >= fixture.cameras.length) {
    // Rendering the scenario whole also refreshes its manifest.
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    return;
  }
  for (const camera of unit.cameras) {
    const path = join(dir, `${camera}.mp4`);
    if (existsSync(path)) rmSync(path, { force: true });
  }
  // The batch rewrites the manifest when it finishes the scenario, so drop the
  // stale one — otherwise the fresh download lands beside it as
  // "manifest (1).json" and nothing ever reads it.
  const manifest = join(dir, "manifest.json");
  if (existsSync(manifest)) rmSync(manifest, { force: true });
}

/**
 * Trim a plan to at most `maxCameras` cameras in total.
 *
 * A page load is all-or-nothing: a wedged renderer or a reload discards every
 * clip that attempt had not already handed to the driver as a download, so an
 * uncapped 12-clip attempt can throw away an hour of rendering. Chunking costs
 * a few seconds of page load per chunk and bounds that loss to one chunk, while
 * the retry loop keeps resuming from whatever is already on disk.
 */
/** Cameras still owed across a plan — the measure of progress between attempts. */
function owedCameras(units: CaptureUnit[]): number {
  return units.reduce((sum, unit) => sum + unit.cameras.length, 0);
}

function capUnits(units: CaptureUnit[], maxCameras: number): CaptureUnit[] {
  const capped: CaptureUnit[] = [];
  let budget = maxCameras;
  for (const unit of units) {
    if (budget <= 0) break;
    const cameras = unit.cameras.slice(0, budget);
    budget -= cameras.length;
    capped.push({ scenarioId: unit.scenarioId, cameras });
  }
  return capped;
}

/** Render the scoped units in one page load, then wait for the bytes to land. */
async function runCaptureAttempt(
  options: CaptureOptions & { url: string },
  units: CaptureUnit[],
  expectedClips: number,
): Promise<AttemptOutcome> {
  // Scope the batch in the URL so the app renders only these scenario/camera
  // pairs. That is what makes a long run resumable: an interrupted attempt
  // costs the units it had not finished, not the tens of minutes already on
  // disk, and it cannot duplicate-suffix clips that already landed.
  const target = new URL(options.url);
  target.searchParams.set(
    "capture",
    units.map((unit) => `${unit.scenarioId}:${unit.cameras.join("+")}`).join(","),
  );
  say(`scoped batch: ${target.searchParams.get("capture")}`);

  const { browser, child } = await launchCaptureBrowser(say);
  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1024, height: 768 },
    });
    const page = await context.newPage();
    const tracker = trackDownloads(ARTIFACTS, say);
    tracker.attach(page);

    // Distinguish the two ways a long render disappears: the document was
    // reloaded (status falls back to the boot line) or the renderer died.
    let documentLoads = 0;
    let crashed = false;
    page.on("load", () => {
      documentLoads += 1;
      if (documentLoads > 1) say(`WARN document load #${documentLoads} — page re-initialized`);
    });
    page.on("crash", () => {
      crashed = true;
      say("ERR renderer crashed");
    });

    const pageErrors: string[] = [];
    page.on("pageerror", (err) => {
      pageErrors.push(`pageerror: ${err.message}`);
      say(`ERR pageerror: ${err.message}`);
    });
    page.on("console", (m) => {
      if (m.type() === "error") {
        pageErrors.push(`console.error: ${m.text()}`);
        say(`ERR console: ${m.text()}`);
      }
    });

    await page.goto(target.toString(), { waitUntil: "load", timeout: 60_000 });
    await page.locator("#rig").waitFor({ state: "visible", timeout: 20_000 });
    await page.locator(STATUS).waitFor({ state: "visible", timeout: 20_000 });
    const renderButton = page.getByRole("button", { name: "RENDER CORPUS" });
    await renderButton.waitFor({ state: "visible", timeout: 20_000 });
    const gl = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>("#rig");
      return c ? Boolean(c.getContext("webgl2") || c.getContext("webgl")) : false;
    });
    if (!gl) fail("WebGL context unavailable on #rig canvas");

    say("clicking RENDER CORPUS...");
    await renderButton.click();

    const startedAt = Date.now();
    const since = (): string => `${Math.round((Date.now() - startedAt) / 1000)}s`;
    let lastStatus = "";
    let lastChange = Date.now();
    let reportedScale = "";
    let lastCamera = "";
    let sawWork = false;
    let lastHeartbeat = Date.now();
    let ok = false;

    while (Date.now() - startedAt < options.timeoutMs) {
      if (crashed) {
        fail(
          `renderer crashed mid-run — the 1080p batch is memory-hungry in a headless ` +
            `software-GL Chromium; check the machine's free RAM and re-run, or capture ` +
            `fewer scenarios per run`,
        );
      }
      let status: string;
      try {
        status = (
          (await withDeadline(page.locator(STATUS).textContent(), STATUS_READ_MS, "status read")) ??
          ""
        ).trim();
      } catch (err) {
        const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
        if (detail?.includes("exceeded")) {
          // The page stopped answering entirely: a wedged renderer or a hung
          // GPU process, not a reloaded document. Say which, because the two
          // need different fixes.
          fail(
            `${detail} — the page stopped answering status reads, so the renderer is wedged ` +
              `rather than merely slow. This attempt's remaining clips were abandoned; clips ` +
              `already written to disk are kept, so re-run to resume from here.`,
          );
        }
        // Otherwise the status element is simply gone, which in practice means
        // the document was replaced and the fresh one had not painted yet.
        // Report that diagnosis rather than a bare Playwright locator timeout.
        fail(
          `lost #capture-status after ${Math.max(documentLoads - 1, 0)} document reload(s) ` +
            `(${detail}) — the page was re-initialized mid-render, so this attempt's remaining ` +
            `clips were abandoned. Artifact writes inside the project and source churn can ` +
            `trigger Vite reloads; run the capture on its own inert server (the default) so ` +
            `nothing in the tree can disturb it. Clips already written to disk are kept; ` +
            `re-run to resume.`,
        );
      }
      if (Date.now() - lastHeartbeat > 60_000) {
        lastHeartbeat = Date.now();
        say(`heartbeat: ${status || "(empty)"} (+${since()})`);
      }
      if (status === BOOT_STATUS && sawWork) {
        fail(
          `page re-initialized mid-run: status read the boot line "${BOOT_STATUS}" after the ` +
            `batch started, so the dev server reloaded the document and the render is gone. ` +
            `Artifact writes inside the project (renders/, *-artifacts/, verify bundles) and ` +
            `source churn trigger Vite reloads — see server.watch.ignored in vite.config.ts — ` +
            `so re-run capture once the tree is quiet (a shared checkout with another agent ` +
            `running the verify suites will reload the page under you).`,
        );
      }
      if (status !== lastStatus) {
        if (status !== BOOT_STATUS) sawWork = true;
        lastStatus = status;
        lastChange = Date.now();
        if (status.startsWith("batch failed:") || status.startsWith("composite failed:")) {
          fail(`${status} (the ${options.url} console has the stack)`);
        }
        const scale = /\((\d+x\d+)\)/.exec(status)?.[1];
        if (scale && scale !== reportedScale) {
          reportedScale = scale;
          const height = Number(scale.split("x")[1]);
          if (height < PRODUCTION_HEIGHT && !options.allowPreview) {
            fail(
              `dev server is capturing at ${scale} — start it without \`--mode smoke\` ` +
                `(\`.env.smoke\` pins ${PRODUCTION_WIDTH}x${PRODUCTION_HEIGHT} capture down to 640x360)`,
            );
          }
        }
        // A 1080p batch runs for tens of minutes, so report camera boundaries
        // and a periodic frame heartbeat rather than sitting silent.
        const progress =
          /^scenario ([a-z0-9-]+): ([a-z0-9-]+) (\d+)\/(\d+) \(camera (\d+)\/(\d+)\)$/.exec(status);
        if (progress) {
          const [, scenarioId, camera, frame, total, cameraIndex, cameraTotal] = progress;
          if (camera !== lastCamera || Number(frame) % 300 === 0) {
            lastCamera = camera ?? "";
            const pct = total ? ((Number(frame) / Number(total)) * 100).toFixed(0) : "?";
            say(
              `rendering ${scenarioId} ${camera} (camera ${cameraIndex}/${cameraTotal}) ` +
                `${frame}/${total} frames (${pct}%, +${since()})`,
            );
          }
        } else if (status.startsWith("encoding") || status.startsWith("saved ")) {
          say(`status: ${status}`);
        }
        if (status.startsWith(DONE_PREFIX)) {
          const count = Number(/(\d+) clips/.exec(status)?.[1] ?? -1);
          if (count !== expectedClips) {
            fail(`status reports ${count} clips, registry expects ${expectedClips}: "${status}"`);
          }
          ok = true;
          break;
        }
      } else if (Date.now() - lastChange > STALL_MS && !lastStatus.startsWith(DONE_PREFIX)) {
        fail(`status stalled for >${STALL_MS}ms: "${lastStatus || "(empty)"}"`);
      }
      await page.waitForTimeout(2000);
    }

    if (!ok) fail(`render did not finish within ${options.timeoutMs}ms`);
    say(`page reported: ${lastStatus}`);

    // The status line fires when the mux finalized, not when the browser has
    // finished writing the file — drain the download channel before validating,
    // and give it a grace window so a save that starts a beat late still lands.
    await tracker.settled();
    await page.waitForTimeout(2000).catch(() => {});
    const { saved, failures } = await tracker.settled();
    say(`downloads: ${saved.length} file(s), ${failures.length} failure(s)`);
    say(`capture scale reported by the page: ${reportedScale || "(unknown)"}`);
    say(`elapsed: ${since()}`);
    if (pageErrors.length > 0) say(`page/console errors observed: ${pageErrors.length}`);

    await context.close().catch(() => {});
    return { downloads: saved.length, scale: reportedScale };
  } finally {
    await browser.close().catch(() => {});
    if (child && child.exitCode === null) child.kill();
  }
}

/**
 * Capture the corpus, resuming across page loads.
 *
 * A 1080p clip is minutes of software-GL rendering, so the whole batch is hours
 * of wall clock — long enough that a reload, a renderer crash, or a thermal
 * stall will interrupt it eventually. Because every clip is now streamed to
 * disk the moment its mux finalizes, each attempt leaves durable progress, and
 * the next attempt simply asks the app for what is still missing. An attempt
 * that makes no progress at all is retried once and then surfaced, so a real
 * breakage fails quickly instead of quietly burning the night.
 */
async function runCapture(options: CaptureOptions & { url: string }): Promise<void> {
  const fixtures = loadScenarioFixtures();
  const expectedClips = fixtures.reduce((sum, f) => sum + f.cameras.length, 0);
  say(`registry: ${fixtures.length} scenarios, ${expectedClips} clips`);
  say(`target: ${RENDERS}`);
  say(
    `expecting ${PRODUCTION_WIDTH}x${PRODUCTION_HEIGHT}; the server reports the real scale, ` +
      `and anything smaller fails unless --allow-preview`,
  );
  say(`dev server: ${options.url}`);

  // This budget counts *failed* attempts, not total attempts. Each attempt only
  // renders a chunk of CAMERAS_PER_ATTEMPT, so a 12-clip run needs several
  // chunks in a row; treating those as retries made the default budget quit
  // with clips still owed. Progress resets it, so it only ever bounds real
  // failures, while `stalledAttempts` still fails fast on a no-progress loop.
  const maxFailures = Number(process.env.FOOTAGE_ATTEMPTS ?? 5);
  let failures = 0;
  let stalledAttempts = 0;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const { done, units } = planRemaining(fixtures, options.allowPreview);
    if (units.length === 0) {
      say(`all ${fixtures.length} scenario(s) already complete on disk`);
      break;
    }
    if (done.length > 0) {
      say(
        `resume: ${done.length}/${fixtures.length} scenario(s) complete, ${units.length} to render`,
      );
    }

    // Bound what a single page load is asked to produce; the retry loop will
    // simply come back for the rest. `units` stays the full debt so the stall
    // detector below compares against the real remaining work.
    const capped = capUnits(units, CAMERAS_PER_ATTEMPT);

    // Clear what this attempt will overwrite before it starts, never after: a
    // mid-attempt abort must leave the partial clip on disk as evidence.
    const byId = new Map(fixtures.map((f) => [f.scenarioId, f]));
    for (const unit of capped) {
      const fixture = byId.get(unit.scenarioId);
      if (fixture) clearUnitRenders(fixture, unit);
    }

    const wantClips = owedCameras(capped);
    const owed = owedCameras(units);
    say(
      `attempt ${attempt}: ${wantClips} clip(s) across ` +
        `${capped.length} scenario(s) ` +
        `[${capped.map((u) => `${u.scenarioId}:${u.cameras.length}`).join(", ")}]` +
        (wantClips < owed ? ` — ${owed - wantClips} more owed after this chunk` : ""),
    );

    let reason = "";
    try {
      const outcome = await runCaptureAttempt(options, capped, wantClips);
      say(
        `attempt ${attempt} finished: ${outcome.downloads} download(s), ` +
          `scale ${outcome.scale || "?"}`,
      );
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
      say(`attempt ${attempt} failed: ${reason}`);
    }

    const after = planRemaining(fixtures, options.allowPreview);
    if (after.units.length === 0) {
      say(`all ${fixtures.length} scenario(s) complete after attempt ${attempt}`);
      break;
    }
    // Progress is measured in cameras, not scenario units: a chunk that lands
    // one camera of two has still earned the run another attempt.
    const progressed = owedCameras(after.units) < owedCameras(units);
    stalledAttempts = progressed ? 0 : stalledAttempts + 1;
    failures = progressed ? 0 : failures + 1;
    if (stalledAttempts >= 2) {
      fail(
        `two attempts in a row made no progress (${owedCameras(after.units)} clip(s) still ` +
          `owed) — stopping instead of re-rendering the same work. ` +
          `Last error: ${reason || "(none)"}`,
      );
    }
    if (failures >= maxFailures) {
      fail(
        `gave up after ${failures} failed attempt(s); ` +
          `${owedCameras(after.units)} clip(s) still owed`,
      );
    }
  }

  const validation = validateRenders(RENDERS, fixtures);
  requireClean(validation, options.allowPreview);
  const bytes = validation.scenarios.reduce(
    (sum, s) => sum + s.clips.reduce((c, clip) => c + clip.bytes, 0),
    0,
  );
  say(
    `RESULT: PASS — ${validation.scenarios.length} scenarios, ` +
      `${validation.scenarios.reduce((n, s) => n + s.clips.length, 0)} clips, ` +
      `${formatBytes(bytes)} (${validation.quality})`,
  );
  say(`next: npm run footage -- bundle`);
}

/**
 * Capture the corpus, on a dev server this process owns unless pointed at one.
 *
 * Driving a server we started ourselves is what makes a long unattended render
 * dependable. It runs with `JOURNEYMAN_CAPTURE_SERVER=1`, so `vite.config.ts`
 * watches nothing and HMR is off — no edit anywhere in the checkout can reload
 * the document and throw the in-flight batch away — and it takes a free port,
 * so it neither fights nor depends on whatever another thread left listening on
 * :5178. Pass `--url` (or FOOTAGE_URL) to target an existing server on purpose.
 */
async function capture(options: CaptureOptions): Promise<void> {
  if (options.url) {
    say(`using the dev server you pointed at: ${options.url}`);
    await runCapture({ ...options, url: options.url });
    return;
  }
  const port = process.env.FOOTAGE_PORT ? Number(process.env.FOOTAGE_PORT) : undefined;
  const server = await startCaptureServer(say, port);
  try {
    await runCapture({ ...options, url: server.url });
  } finally {
    await server.stop();
    say("capture server stopped");
  }
}

// ---------------------------------------------------------------------------
// bundle
// ---------------------------------------------------------------------------

interface BundleOptions {
  allowPreview: boolean;
  tag: string;
}

function bundle(options: BundleOptions): FootageIndex {
  const fixtures = loadScenarioFixtures();
  const validation = validateRenders(RENDERS, fixtures);
  requireClean(validation, options.allowPreview);

  const git = gitState();
  const firstManifest = JSON.parse(
    readFileSync(join(RENDERS, `${fixtures[0]?.scenarioId ?? ""}`, "manifest.json"), "utf8"),
  ) as CaptureManifest;
  const index: FootageIndex = {
    index: "journeyman-footage",
    indexVersion: 1,
    generatedUtc: new Date().toISOString(),
    repo: REPO,
    tag: options.tag,
    commit: git.commit,
    worktreeClean: git.clean,
    engineVersion: firstManifest.capture?.engineVersion ?? "",
    quality: validation.quality,
    capture: {
      width: validation.scenarios[0]?.clips[0]?.width ?? 0,
      height: validation.scenarios[0]?.clips[0]?.height ?? 0,
      fps: fixtures[0]?.fps ?? 0,
    },
    totals: { scenarios: 0, clips: 0, bytes: 0 },
    scenarios: validation.scenarios,
  };
  index.totals = {
    scenarios: index.scenarios.length,
    clips: index.scenarios.reduce((n, s) => n + s.clips.length, 0),
    bytes: index.scenarios.reduce(
      (sum, s) => sum + s.clips.reduce((c, clip) => c + clip.bytes, 0),
      0,
    ),
  };

  writeJson(INDEX_FILE, index);
  say(`index: ${INDEX_FILE} (${index.quality}, ${index.capture.width}x${index.capture.height})`);
  say(
    `bundle: ${index.totals.scenarios} scenarios, ${index.totals.clips} clips, ` +
      `${formatBytes(index.totals.bytes)}`,
  );
  for (const scenario of index.scenarios) {
    const cameras = scenario.clips.map((c) => `${c.camera} ${formatBytes(c.bytes)}`).join(", ");
    say(`  ${scenario.id}: ${cameras}`);
  }
  if (index.quality === "preview") say("warning: bundling PREVIEW quality — not for the brag edit");
  say(`next: npm run footage -- publish --tag ${options.tag}`);
  return index;
}

function readIndex(): FootageIndex {
  if (!existsSync(INDEX_FILE)) fail(`no bundle at ${INDEX_FILE} — run: npm run footage -- bundle`);
  return JSON.parse(readFileSync(INDEX_FILE, "utf8")) as FootageIndex;
}

/** Local file paths for every artifact the index references, in upload order. */
function bundleFiles(index: FootageIndex): string[] {
  const files: string[] = [];
  for (const scenario of index.scenarios) {
    for (const clip of scenario.clips) files.push(join(RENDERS, scenario.id, `${clip.camera}.mp4`));
    files.push(join(RENDERS, scenario.id, "manifest.json"));
  }
  return files;
}

// ---------------------------------------------------------------------------
// publish / fetch
// ---------------------------------------------------------------------------

function gh(args: string[]): void {
  // libuv resolves PATHEXT, but be explicit about the Windows shim.
  const candidates = process.platform === "win32" ? ["gh", "gh.exe"] : ["gh"];
  for (const bin of candidates) {
    const res = spawnSync(bin, args, { stdio: "inherit" });
    const missing = (res.error as { code?: string } | undefined)?.code === "ENOENT";
    if (missing) continue;
    if (res.error) fail(`gh ${args.join(" ")} failed: ${String(res.error)}`);
    if (res.status !== 0) fail(`gh ${args.join(" ")} exited ${res.status}`);
    return;
  }
  fail("gh not found on PATH — install the GitHub CLI, or upload manually (see --dry-run)");
}

/** Run `gh` and return its stdout, for the queries whose answer we branch on. */
function ghCapture(args: string[]): string {
  const candidates = process.platform === "win32" ? ["gh", "gh.exe"] : ["gh"];
  for (const bin of candidates) {
    const res = spawnSync(bin, args, { encoding: "utf8" });
    const missing = (res.error as { code?: string } | undefined)?.code === "ENOENT";
    if (missing) continue;
    if (res.error) fail(`gh ${args.join(" ")} failed: ${String(res.error)}`);
    if (res.status !== 0) fail(`gh ${args.join(" ")} exited ${res.status}: ${res.stderr?.trim()}`);
    return res.stdout ?? "";
  }
  fail("gh not found on PATH — install the GitHub CLI, or upload manually (see --dry-run)");
}

/** Asset names currently on the release, as GitHub reports them. */
function releasedAssetNames(tag: string): Set<string> {
  const out = ghCapture(["api", `repos/${REPO}/releases/tags/${tag}`, "--jq", ".assets[].name"]);
  return new Set(
    out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

interface PublishOptions {
  tag: string;
  dryRun: boolean;
  allowPreview: boolean;
}

function releaseNotes(index: FootageIndex): string {
  const lines = [
    `Brag-footage corpus for the Journeyman launch video (wollacksystems/journeyman#29).`,
    ``,
    `- Quality: **${index.quality}** at ${index.capture.width}x${index.capture.height} @ ${index.capture.fps}fps`,
    `- ${index.totals.scenarios} scenarios, ${index.totals.clips} clips, ${formatBytes(index.totals.bytes)}`,
    `- Rendered from \`${index.commit ?? "unknown"}\`${index.worktreeClean ? "" : " (dirty worktree)"}`,
    `- Per-file sha256 plus the beat/narration timeline: \`footage.json\``,
    ``,
    `Fetch it into a renders/ layout and verify every checksum:`,
    ``,
    "```bash",
    `npm run footage -- fetch --tag ${index.tag}`,
    "```",
    ``,
    `Scenarios: ${index.scenarios.map((s) => s.id).join(", ")}`,
  ];
  return lines.join("\n");
}

function publish(options: PublishOptions): void {
  const index = readIndex();
  if (index.quality !== "production" && !options.allowPreview) {
    fail(`refusing to publish ${index.quality} footage without --allow-preview`);
  }
  // Re-validate the bytes before they leave the machine.
  const validation = validateRenders(RENDERS, loadScenarioFixtures());
  requireClean(validation, options.allowPreview);

  const files = bundleFiles(index);
  const missing = files.filter((f) => !existsSync(f));
  if (missing.length > 0) fail(`bundle references missing file(s): ${missing.join(", ")}`);

  if (options.dryRun) {
    say(`dry run — would publish to ${REPO}@${options.tag}:`);
    for (const asset of [
      ...index.scenarios.flatMap((s) => s.clips.map((c) => c.asset)),
      ...index.scenarios.map((s) => s.manifestAsset),
      "footage.json",
    ]) {
      say(`  asset: ${asset}`);
    }
    say(`index would live at ${releaseBase(options.tag, REPO)}/footage.json`);
    return;
  }

  const existing = spawnSync("gh", ["release", "view", options.tag, "-R", REPO], {
    encoding: "utf8",
  });
  if (existing.status !== 0) {
    say(`creating release ${options.tag}...`);
    gh([
      "release",
      "create",
      options.tag,
      "-R",
      REPO,
      "--title",
      `Brag footage (${index.quality} ${index.capture.width}x${index.capture.height})`,
      "--notes",
      releaseNotes(index),
    ]);
  } else {
    say(`release ${options.tag} exists — uploading with --clobber`);
  }

  // Release assets are flat and a GitHub asset's *name* — the thing in the
  // download URL, and the only uniqueness key — is always the uploaded file's
  // basename. `gh release upload file#thing` sets a display *label* instead,
  // which download URLs ignore, so uploading renders in place would publish
  // three clips literally named `side-a.mp4` (one per scenario) and every URL
  // in the index would 404. Stage each file under its recorded asset name and
  // upload the staged copy.
  const staging = join(ARTIFACTS, "staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const assets: string[] = [];
  for (const scenario of index.scenarios) {
    for (const clip of scenario.clips) {
      const from = join(RENDERS, scenario.id, `${clip.camera}.mp4`);
      copyFileSync(from, join(staging, clip.asset));
      assets.push(clip.asset);
    }
    copyFileSync(
      join(RENDERS, scenario.id, "manifest.json"),
      join(staging, scenario.manifestAsset),
    );
    assets.push(scenario.manifestAsset);
  }
  copyFileSync(INDEX_FILE, join(staging, "footage.json"));
  assets.push("footage.json");

  try {
    say(`uploading ${assets.length} asset(s)...`);
    // A release is not always visible to the asset host the instant it is
    // created, so the first attempt can 404 for a release that plainly exists.
    // Retry rather than leaving a half-populated release behind.
    const uploadAttempts = Number(process.env.FOOTAGE_UPLOAD_ATTEMPTS ?? 3);
    for (let attempt = 1; ; attempt++) {
      try {
        gh([
          "release",
          "upload",
          options.tag,
          ...assets.map((asset) => join(staging, asset)),
          "-R",
          REPO,
          "--clobber",
        ]);
        break;
      } catch (err) {
        if (attempt >= uploadAttempts) throw err;
        say(
          `upload attempt ${attempt} failed (${
            err instanceof Error ? err.message.split("\n")[0] : String(err)
          }) — retrying in 5s`,
        );
        sleepSync(5000);
      }
    }

    // Trust the release, not the uploader: assert every asset the index names
    // is actually on the release, so a partial upload fails here instead of at
    // whoever runs `fetch` next.
    const onRelease = releasedAssetNames(options.tag);
    const absent = assets.filter((asset) => !onRelease.has(asset));
    if (absent.length > 0) {
      fail(
        `release is missing ${absent.length} asset(s) after upload: ` +
          `${absent.slice(0, 5).join(", ")}${absent.length > 5 ? ", …" : ""}`,
      );
    }
    say(`release holds all ${assets.length} asset(s)`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  say(`published: ${releaseBase(options.tag, REPO)}/footage.json`);
  say(`next: npm run footage -- fetch --tag ${options.tag}`);
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) fail(`GET ${url} → ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(join(dest, ".."), { recursive: true });
  const part = `${dest}.part`;
  writeFileSync(part, buf);
  renameSync(part, dest);
}

interface FetchOptions {
  tag: string;
  repo: string;
  checkOnly: boolean;
  fromBundle: boolean;
  allowPreview: boolean;
}

/**
 * Bring the published footage into the local `renders/` layout, verifying every
 * file's sha256 against the index — idempotent, so a re-run only refetches what
 * is missing or corrupted.
 */
async function fetchFootage(options: FetchOptions): Promise<void> {
  const base = releaseBase(options.tag, options.repo);
  let index: FootageIndex;
  if (options.fromBundle) {
    index = readIndex();
    say(`index: ${INDEX_FILE} (local bundle)`);
  } else {
    say(`index: ${base}/footage.json`);
    const res = await fetch(`${base}/footage.json`);
    if (!res.ok) {
      fail(
        `GET ${base}/footage.json → ${res.status}. Publish the bundle first ` +
          `(npm run footage -- publish --tag ${options.tag}), or pass --from-bundle to use a local one.`,
      );
    }
    index = (await res.json()) as FootageIndex;
  }

  if (index.quality !== "production" && !options.allowPreview) {
    fail(
      `index declares ${index.quality} footage (${index.capture.width}x${index.capture.height}); ` +
        `the brag edits from production quality. Re-render, or pass --allow-preview to accept it deliberately.`,
    );
  }

  const wanted: Array<{ file: string; asset: string; sha256: string; bytes: number }> = [];
  for (const scenario of index.scenarios) {
    for (const clip of scenario.clips) {
      wanted.push({ file: clip.file, asset: clip.asset, sha256: clip.sha256, bytes: clip.bytes });
    }
    wanted.push({
      file: scenario.manifestFile,
      asset: scenario.manifestAsset,
      sha256: scenario.manifestSha256 ?? "",
      bytes: scenario.manifestBytes ?? 0,
    });
  }

  let fetched = 0;
  let verified = 0;
  let unverifiable = 0;
  let bytes = 0;
  const mismatches: string[] = [];

  for (const item of wanted) {
    const dest = join(ARTIFACTS, item.file);
    const current = existsSync(dest) ? sha256File(dest) : null;
    // An index entry with no checksum cannot be verified, and saying so beats
    // counting it as a pass: that is how three manifests rode along unchecked
    // while the summary claimed every file was verified.
    const checkable = item.sha256 !== "";
    const countOk = (): void => {
      if (checkable) verified += 1;
      else unverifiable += 1;
    };
    if (current !== null && (!checkable || current === item.sha256)) {
      countOk();
      bytes += statSync(dest).size;
      continue;
    }
    if (options.checkOnly) {
      mismatches.push(`${item.file}: ${current === null ? "missing" : "sha256 mismatch"}`);
      continue;
    }
    say(`fetching ${item.asset}...`);
    await downloadFile(`${base}/${item.asset}`, dest);
    fetched += 1;
    if (checkable) {
      const got = sha256File(dest);
      if (got !== item.sha256) {
        rmSync(dest, { force: true });
        mismatches.push(`${item.file}: sha256 ${got} != ${item.sha256}`);
        continue;
      }
    } else {
      say(`  no checksum in the index for ${item.file} — downloaded but not verified`);
    }
    countOk();
    bytes += statSync(dest).size;
  }

  if (mismatches.length > 0) {
    for (const problem of mismatches) say(`  - ${problem}`);
    fail(`${mismatches.length} file(s) failed verification`);
  }

  writeJson(LOCK_FILE, {
    tag: index.tag,
    repo: options.repo,
    quality: index.quality,
    capture: index.capture,
    commit: index.commit,
    verifiedUtc: new Date().toISOString(),
    files: wanted.map((w) => ({ file: w.file, sha256: w.sha256 })),
  });

  say(
    `${options.checkOnly ? "checked" : "fetched"} ${options.checkOnly ? verified : fetched} file(s), ` +
      `${verified} verified, ${formatBytes(bytes)}` +
      (unverifiable > 0 ? `, ${unverifiable} without a checksum in the index` : ""),
  );
  say(`renders: ${join(ARTIFACTS, "renders")}`);
  say(`lock: ${LOCK_FILE}`);
  for (const scenario of index.scenarios) {
    const cameras = scenario.clips.map((c) => c.camera).join(", ");
    say(`  ${scenario.id}: ${cameras} @ ${index.capture.width}x${index.capture.height}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: Command;
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [rawCommand, ...rest] = argv;
  const commands: Command[] = ["capture", "bundle", "publish", "fetch"];
  if (!rawCommand || !commands.includes(rawCommand as Command)) {
    console.error(
      "usage: node scripts/footage.mts <capture|bundle|publish|fetch> [flags]\n" +
        "  capture   render the corpus at production scale into scripts/footage-artifacts/\n" +
        "            (starts its own inert dev server; --url targets an existing one)\n" +
        "  bundle    validate the renders and write the published index (footage.json)\n" +
        "  publish   gh release create/upload the bundle [--tag t] [--dry-run]\n" +
        "  fetch     download + verify the index [--tag t] [--repo o/r] [--check] [--from-bundle]\n" +
        "  common    --allow-preview accepts sub-1080p footage, exit 2 is a usage error",
    );
    process.exit(2);
  }
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i] ?? "";
    if (flag === "--allow-preview" || flag === "--dry-run" || flag === "--check") {
      flags.set(flag.slice(2), true);
    } else if (flag === "--from-bundle") {
      flags.set("from-bundle", true);
    } else if (flag === "--tag" || flag === "--repo" || flag === "--url" || flag === "--timeout") {
      const value = rest[++i];
      if (value === undefined) {
        console.error(`flag ${flag} needs a value`);
        process.exit(2);
      }
      flags.set(flag.slice(2), value);
    } else {
      console.error(`unknown flag: ${flag}`);
      process.exit(2);
    }
  }
  return { command: rawCommand as Command, flags };
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const tag = String(flags.get("tag") ?? TAG);
  const allowPreview = flags.get("allow-preview") === true;

  switch (command) {
    case "capture":
      say(`capture → ${REPO}@${tag}`);
      await capture({
        url: flags.get("url") ? String(flags.get("url")) : BASE_URL,
        allowPreview,
        timeoutMs: Number(flags.get("timeout") ?? HARD_TIMEOUT_MS),
      });
      saveLog("capture.log");
      return;
    case "bundle":
      bundle({ allowPreview, tag });
      return;
    case "publish":
      publish({ tag, dryRun: flags.get("dry-run") === true, allowPreview });
      return;
    case "fetch":
      await fetchFootage({
        tag,
        repo: String(flags.get("repo") ?? REPO),
        checkOnly: flags.get("check") === true,
        fromBundle: flags.get("from-bundle") === true,
        allowPreview,
      });
      return;
    default:
      console.error(`unhandled command: ${command}`);
      process.exit(2);
  }
}

main()
  .then(() => {
    saveLog("footage.log");
    process.exit(0);
  })
  .catch((err: unknown) => {
    say(`FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    saveLog("footage.log");
    process.exit(1);
  });
