/**
 * Headless smoke test for the synthetic-capture dev flow.
 *
 * Requires `npm run dev` on the port configured below (default :5178).
 * Requires a Playwright-managed Chromium build (run once:
 * `npx playwright-core install chromium`). Loading and driving is done
 * with Playwright's own matching browser. On machines where Playwright's
 * anonymous-pipe launch handshake is blocked (some EDR/AV setups hang
 * `chromium.launch` forever after spawning the process), the script
 * falls back to spawning the browser with `--remote-debugging-port` and
 * connecting via CDP-over-HTTP. Set SMOKE_USE_CDP=1 to force the fallback.
 *
 * Flow: load the page, assert the capture UI wiring, then trigger
 * RENDER CORPUS and treat the on-page status line
 * "saved renders/<scenario>/: N clips + manifest" (only reachable after
 * encode + mux + finalize succeed) as the end-to-end pass signal.
 *
 * Usage: npm run smoke   (or: node scripts/smoke.mts; requires Node 23.6+)
 */

import { chromium, type Browser, type Download, type Page } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const BASE_URL = process.env.SMOKE_URL ?? "http://localhost:5178";
const STATUS = "#capture-status";
const DONE_PREFIX = "saved renders/";
const HARD_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 2_400_000);
const STALL_MS = Number(process.env.SMOKE_STALL_MS ?? 240_000);
const EXPECTED_SCENARIOS = ["sensor-trip", "way-lube", "atc-jam"] as const;
const EXPECTED_CAMERAS = ["side-a", "side-b", "head", "chest"] as const;
const EXPECTED_FINAL = "saved renders/: 3 scenarios + 12 clips + manifests";
const ARTIFACTS = join("scripts", "smoke-artifacts");
/** Preview render size for PR-embeddable proof clips (production default is 1920x1080). */
const PREVIEW_WIDTH = 640;
const PREVIEW_HEIGHT = 360;
/** Preview target bitrate (MediaRecorder webm) kept well under GitHub's 10 MB asset cap. */
const PREVIEW_BITS_PER_SECOND = 900_000;

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * Chromium flattens slashes in download names, so the app's
 * "renders/<scenarioId>/<file>" target arrives as "renders_<scenarioId>_<file>"
 * (corpus exports flatten the same way under "corpora_<seed>_..."). Restore
 * the structured layout (scenario ids and cameras use hyphens only).
 */
function structuredPath(suggested: string): string {
  const flat = suggested.replace(/\\/g, "/");
  const corpora = /^corpora_(\d+)_(.+)$/.exec(flat);
  if (corpora) {
    // corpora/<seed>/<segment>/... — ids carry no underscores, so the
    // remaining underscores are exactly the directory separators.
    const [, seed, rest] = corpora;
    const parts = rest.split("_");
    return `corpora/${seed}/${parts[0]}/${parts.slice(1).join("/")}`;
  }
  const match = /^renders_([a-z0-9-]+)_(.+)$/.exec(flat);
  return match ? `renders/${match[1]}/${match[2]}` : flat;
}

/** Persist one browser download to the durable artifacts dir. */
async function saveDownload(dl: Download): Promise<{ rel: string; size: number }> {
  const rel = structuredPath(dl.suggestedFilename() ?? "download.bin");
  const dest = join(ARTIFACTS, rel);
  mkdirSync(dirname(dest), { recursive: true });
  const out = createWriteStream(dest);
  const stream = await dl.createReadStream();
  if (!stream) throw new Error(`empty download stream for ${suggested}`);
  await new Promise<void>((resolve, reject) => {
    stream.pipe(out);
    out.on("finish", () => resolve());
    out.on("error", reject);
    stream.on("error", reject);
  });
  return { rel, size: statSync(dest).size };
}

function validateFixtures(): void {
  for (const scenarioId of EXPECTED_SCENARIOS) {
    const fixture = JSON.parse(readFileSync(join("fixtures", `${scenarioId}.json`), "utf8")) as {
      scenarioId?: string;
      durationSec?: number;
      fps?: number;
      cameras?: string[];
      beats?: unknown[];
      narration?: unknown[];
      lesson?: { title?: string; body?: string };
    };
    if (
      fixture.scenarioId !== scenarioId ||
      fixture.durationSec !== 50 ||
      fixture.fps !== 30 ||
      JSON.stringify(fixture.cameras) !== JSON.stringify(EXPECTED_CAMERAS) ||
      !fixture.beats?.length ||
      !fixture.narration?.length ||
      !fixture.lesson?.title ||
      !fixture.lesson.body
    ) {
      throw new Error(`fixture shape invalid: ${scenarioId}`);
    }
  }
  say(
    `fixtures ok: ${EXPECTED_SCENARIOS.length} scenarios, ${EXPECTED_CAMERAS.length} cameras each`,
  );
}

const log: string[] = [];

function say(line: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  const msg = `[${ts}] ${line}`;
  log.push(msg);
  process.stdout.write(msg + "\n");
}

function saveLog(): void {
  try {
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(join(ARTIFACTS, "smoke.log"), log.join("\n") + "\n");
  } catch {
    // best effort
  }
}

async function screenshot(page: Page, name: string): Promise<void> {
  try {
    mkdirSync(ARTIFACTS, { recursive: true });
    await page.screenshot({ path: join(ARTIFACTS, `${name}.png`) });
  } catch (err) {
    say(`warn: screenshot ${name} failed: ${String(err)}`);
  }
}

function summarizeStatus(s: string): string | null {
  const cam = /^([a-z0-9-]+) (\d+)\/(\d+) \(camera \d+\/\d+\)$/.exec(s);
  if (cam) return `frame ${cam[2]}/${cam[3]} (${cam[1]})`;
  return s;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function spawnBrowserWithCdp(): Promise<{ browser: Browser; child: ChildProcess }> {
  const exe = chromium.executablePath();
  const port = await getFreePort();
  const profile = join(tmpdir(), `journeyman-smoke-cdp-${process.pid}`);
  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--headless",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--enable-unsafe-swiftshader",
      "--mute-audio",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  child.stderr?.resume();
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`cdp browser exited with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${endpoint}/json/version`);
      if (res.ok) {
        up = true;
        break;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) throw new Error(`cdp browser did not become ready at ${endpoint}`);
  const browser = await chromium.connectOverCDP(endpoint);
  return { browser, child };
}

async function runCaptureFlow(browser: Browser): Promise<boolean> {
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1024, height: 768 },
  });
  const page = await context.newPage();
  let saved = 0;

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

  page.on("download", (dl) => {
    void saveDownload(dl)
      .then(({ rel, size }) => {
        saved += 1;
        say(`saved artifact: ${rel} (${formatBytes(size)})`);
      })
      .catch((err: unknown) =>
        say(`ERR download: ${err instanceof Error ? err.message : String(err)}`),
      );
  });

  validateFixtures();
  say(`preview render size: ${PREVIEW_WIDTH}x${PREVIEW_HEIGHT} (production default 1920x1080)`);
  say("navigating...");
  await page.goto(BASE_URL, { waitUntil: "load", timeout: 60_000 });

  await page.locator("#rig").waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(STATUS).waitFor({ state: "visible", timeout: 20_000 });
  const renderButton = page.getByRole("button", { name: "RENDER CORPUS" });
  await renderButton.waitFor({ state: "visible", timeout: 20_000 });
  const recButton = page.getByRole("button", { name: "REC COMPOSITE" });
  await recButton.waitFor({ state: "visible", timeout: 20_000 });
  say("ui ok: #rig canvas, #capture-status, REC COMPOSITE and RENDER CORPUS buttons visible");

  const canvasInfo = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>("#rig");
    return c ? { width: c.width, height: c.height } : null;
  });
  say(`canvas: ${JSON.stringify(canvasInfo)}`);
  const gl = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>("#rig");
    return c ? Boolean(c.getContext("webgl2") || c.getContext("webgl")) : false;
  });
  if (!gl) throw new Error("WebGL context unavailable on #rig canvas");

  await screenshot(page, "00-scene-loaded");
  await page.waitForTimeout(1500);
  await screenshot(page, "01-scene-driven");
  say("scenario drives: two screenshots captured 1.5s apart");

  // Preview pass: record a short GitHub-embeddable composite per scenario.
  const select = page.locator("#scenario-select");
  for (const scenarioId of EXPECTED_SCENARIOS) {
    await select.selectOption(scenarioId);
    say(`preview: selected ${scenarioId}, recording composite...`);
    await recButton.click();
    await page
      .locator(STATUS)
      .filter({ hasText: new RegExp(`^saved renders/${scenarioId}/composite\\.webm$`) })
      .waitFor({ state: "visible", timeout: 300_000 });
    say(`preview: saved ${scenarioId} composite`);
    await screenshot(page, `04-preview-${scenarioId}`);
  }
  await select.selectOption(EXPECTED_SCENARIOS[0]!);

  // Embed safety: each webm must fit GitHub's 10 MB attachment limit with margin.
  const maxWebmBytes = (PREVIEW_BITS_PER_SECOND / 8) * 50 * 1.25;
  for (const scenarioId of EXPECTED_SCENARIOS) {
    const webmPath = join(ARTIFACTS, "renders", scenarioId, "composite.webm");
    const size = statSync(webmPath).size;
    if (size > maxWebmBytes) {
      throw new Error(
        `preview ${scenarioId} webm too large for PR embed: ${formatBytes(size)} > ${formatBytes(maxWebmBytes)}`,
      );
    }
    say(`preview size ok: ${scenarioId} composite ${formatBytes(size)}`);
  }

  say("clicking RENDER CORPUS...");
  await renderButton.click();
  await page.waitForTimeout(1500);
  await screenshot(page, "02-batch-start");

  const startedAt = Date.now();
  let lastStatus = "";
  let lastChange = Date.now();
  let lastCamera = "";
  let finalStatus = "";
  let ok = false;

  while (Date.now() - startedAt < HARD_TIMEOUT_MS) {
    const s = ((await page.locator(STATUS).textContent()) ?? "").trim();
    if (s === lastStatus) {
      if (Date.now() - lastChange > STALL_MS && !s.startsWith(DONE_PREFIX)) {
        throw new Error(`status stalled for >${STALL_MS}ms: "${s}"`);
      }
    } else {
      lastStatus = s;
      lastChange = Date.now();
      if (s.startsWith("batch failed:") || s.startsWith("composite failed:")) {
        throw new Error(s);
      }
      const sum = summarizeStatus(s);
      if (sum) say(`status: ${sum}`);
      const camera = /^([a-z0-9-]+)\s+\d+\/\d+/.exec(s)?.[1] ?? "";
      if (s.startsWith("encoding")) say(`status: ${s}`);
      if (camera && camera !== lastCamera) {
        lastCamera = camera;
        say(`camera start: ${camera}`);
      }
      if (s === EXPECTED_FINAL) {
        finalStatus = s;
        ok = true;
        break;
      }
    }
    await page.waitForTimeout(2000);
  }

  await screenshot(page, "03-final");
  say(
    ok && finalStatus === EXPECTED_FINAL
      ? `RESULT: PASS — ${finalStatus}`
      : `RESULT: FAIL — ${finalStatus || "timed out"}`,
  );
  if (ok && finalStatus !== EXPECTED_FINAL) {
    throw new Error(`partial corpus render: expected "${EXPECTED_FINAL}", got "${finalStatus}"`);
  }
  if (pageErrors.length > 0) say(`page/console errors observed: ${pageErrors.length}`);
  say(`durable artifacts: ${saved} file(s) under ${ARTIFACTS}`);

  await context.close().catch(() => {});
  return ok;
}

async function main(): Promise<boolean> {
  say(`base: ${BASE_URL}`);

  let browser: Browser;
  let child: ChildProcess | null = null;
  if (process.env.SMOKE_USE_CDP === "1") {
    say("launching via CDP (SMOKE_USE_CDP=1)...");
    ({ browser, child } = await spawnBrowserWithCdp());
  } else {
    try {
      browser = await chromium.launch({
        headless: true,
        timeout: 20_000,
        args: ["--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
      });
      say("launched via Playwright-managed chromium");
    } catch (err) {
      say(`playwright launch failed: ${err instanceof Error ? err.message : String(err)}`);
      say("falling back to CDP-over-HTTP launch...");
      ({ browser, child } = await spawnBrowserWithCdp());
    }
  }

  try {
    return await runCaptureFlow(browser);
  } finally {
    await browser.close().catch(() => {});
    if (child && child.exitCode === null) child.kill();
  }
}

main()
  .then((ok) => {
    saveLog();
    process.exit(ok ? 0 : 1);
  })
  .catch((err: unknown) => {
    say(`FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    saveLog();
    process.exit(1);
  });
