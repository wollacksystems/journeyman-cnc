/**
 * Shared headless-capture plumbing for the render drivers (`scripts/smoke.mts`,
 * `scripts/footage.mts`).
 *
 * Both drivers run the same shape of job: open the dev server in a
 * Playwright-managed Chromium (falling back to CDP-over-HTTP on machines whose
 * EDR/AV blocks Playwright's anonymous-pipe launch handshake), click a capture
 * button in the dev toolbar, and persist whatever the page downloads — the
 * download channel is the only path the renderer has out of the page.
 *
 * The download tracker matters more than it looks. The page reports a scenario
 * finished when the mux is finalized, which is *before* the browser has streamed
 * the bytes to disk, so a driver that closes its context right after the status
 * line loses the tail of the run to `download.createReadStream: canceled` —
 * which is exactly how the 2026-09-14 batch left `atc-jam/*.mp4` on disk as
 * 0-byte stubs. Drivers must `await tracker.settled()` before closing the
 * browser, and must validate the files that landed instead of trusting the
 * status line.
 */

import {
  chromium,
  type Browser,
  type ChildProcess,
  type Download,
  type Page,
} from "playwright-core";
import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Sink for driver progress lines (each script owns its own prefix/timestamping). */
export type DriverLog = (line: string) => void;

/** WebGL in a headless Chromium, including the software fallback. */
const LAUNCH_ARGS = ["--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"];

/** Production capture size (locked in the README; `.env.smoke` scales it down). */
export const PRODUCTION_WIDTH = 1920;
export const PRODUCTION_HEIGHT = 1080;

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
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

/** A dev server this process owns, on a port nobody else can be using. */
export interface ManagedServer {
  url: string;
  stop(): Promise<void>;
}

/**
 * Start a capture-only dev server that cannot reload the document.
 *
 * The driver owns the server instead of borrowing whatever is listening on a
 * shared port, for two reasons. It sets `JOURNEYMAN_CAPTURE_SERVER=1`, which
 * makes `vite.config.ts` watch nothing and disable HMR, closing the whole class
 * of "an edit landed mid-render and the batch evaporated" failures that cost
 * three runs on 2026-09-24. And because it picks a free port, a long capture no
 * longer collides with — or is taken hostage by — the dev servers other threads
 * keep running in the same checkout.
 */
export async function startCaptureServer(log: DriverLog, port?: number): Promise<ManagedServer> {
  const chosen = port ?? (await getFreePort());
  const bin = join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(bin)) {
    throw new Error(`vite not found at ${bin} — run \`npm install\` first`);
  }
  // --host pins the server to IPv4 loopback so the readiness probe below hits
  // the same address Vite bound, and --strictPort keeps it from silently
  // landing on a different port than the one we are about to poll.
  // `FOOTAGE_SERVER_MODE=smoke` reproduces the scaled-down preview capture
  // (`.env.smoke`) that the proofs and CI runs use, so the driver can exercise
  // the same code path at 640x360 instead of paying minutes per clip.
  const mode = process.env.FOOTAGE_SERVER_MODE;
  const child = spawn(
    process.execPath,
    [
      bin,
      "--port",
      String(chosen),
      "--strictPort",
      "--host",
      "127.0.0.1",
      ...(mode ? ["--mode", mode] : []),
    ],
    {
      env: { ...process.env, JOURNEYMAN_CAPTURE_SERVER: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const url = `http://127.0.0.1:${chosen}/`;
  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`capture server exited with code ${child.exitCode}:\n${output.trim()}`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) {
        up = true;
        break;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) {
    child.kill();
    throw new Error(`capture server did not answer at ${url} within 60s:\n${output.trim()}`);
  }
  log(`capture server ready at ${url} (inert: no watcher, no HMR)`);

  return {
    url,
    async stop(): Promise<void> {
      if (child.exitCode !== null || child.pid === undefined) return;
      if (process.platform === "win32") {
        // Vite spawns an esbuild service child; kill the tree so a long-lived
        // capture does not leave a stray listener behind for the next run.
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
      await new Promise((r) => setTimeout(r, 300));
    },
  };
}

async function spawnBrowserWithCdp(
  log: DriverLog,
): Promise<{ browser: Browser; child: ChildProcess }> {
  const exe = chromium.executablePath();
  const port = await getFreePort();
  const profile = join(tmpdir(), `journeyman-capture-cdp-${process.pid}`);
  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--headless",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      ...LAUNCH_ARGS,
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
  log(`cdp browser ready at ${endpoint}`);
  const browser = await chromium.connectOverCDP(endpoint);
  return { browser, child };
}

/**
 * Launch the capture browser: Playwright's own launcher when the pipe handshake
 * works, the CDP fallback otherwise. `CAPTURE_USE_CDP=1` forces the fallback
 * (`SMOKE_USE_CDP=1` is honored as the older alias).
 */
export async function launchCaptureBrowser(
  log: DriverLog,
): Promise<{ browser: Browser; child: ChildProcess | null }> {
  if (process.env.CAPTURE_USE_CDP === "1" || process.env.SMOKE_USE_CDP === "1") {
    log("launching via CDP (CAPTURE_USE_CDP=1)...");
    return await spawnBrowserWithCdp(log);
  }
  try {
    const browser = await chromium.launch({
      headless: true,
      timeout: 20_000,
      args: LAUNCH_ARGS,
    });
    log("launched via Playwright-managed chromium");
    return { browser, child: null };
  } catch (err) {
    log(`playwright launch failed: ${err instanceof Error ? err.message : String(err)}`);
    log("falling back to CDP-over-HTTP launch...");
    return await spawnBrowserWithCdp(log);
  }
}

/**
 * Chromium flattens slashes in download names, so the app's
 * "renders/<scenarioId>/<file>" target arrives as "renders_<scenarioId>_<file>"
 * (corpus exports flatten the same way under "corpora_<seed>_..."). Restore the
 * structured layout (scenario ids and cameras use hyphens only).
 */
export function structuredPath(suggested: string): string {
  const flat = suggested.replace(/\\/g, "/");
  const corpora = /^corpora_(\d+)_(.+)$/.exec(flat);
  if (corpora) {
    // corpora/<seed>/<segment>/... — ids carry no underscores, so the
    // remaining underscores are exactly the directory separators.
    const [, seed, rest] = corpora;
    const parts = (rest ?? "").split("_");
    return `corpora/${seed}/${parts[0]}/${parts.slice(1).join("/")}`;
  }
  const match = /^renders_([a-z0-9-]+)_(.+)$/.exec(flat);
  return match ? `renders/${match[1]}/${match[2]}` : flat;
}

export interface DownloadRecord {
  rel: string;
  bytes: number;
}

export interface DownloadTracker {
  /** Persist every download the page starts, under `<artifactsRoot>/<rel path>`. */
  attach(page: Page): void;
  /** Resolve once every started download has been written (or has failed). */
  settled(): Promise<{ saved: DownloadRecord[]; failures: string[] }>;
}

/** Persist page downloads to a durable artifacts dir and expose a settle point. */
export function trackDownloads(artifactsRoot: string, log: DriverLog): DownloadTracker {
  const pending = new Set<Promise<void>>();
  const saved: DownloadRecord[] = [];
  const failures: string[] = [];

  async function saveDownload(dl: Download): Promise<void> {
    const rel = structuredPath(dl.suggestedFilename() ?? "download.bin");
    const dest = join(artifactsRoot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    const out = createWriteStream(dest);
    const stream = await dl.createReadStream();
    if (!stream) throw new Error(`empty download stream for ${rel}`);
    await new Promise<void>((resolve, reject) => {
      stream.pipe(out);
      out.on("finish", () => resolve());
      out.on("error", reject);
      stream.on("error", reject);
    });
    const bytes = statSync(dest).size;
    saved.push({ rel, bytes });
    log(`saved artifact: ${rel} (${formatBytes(bytes)})`);
  }

  return {
    attach(page: Page): void {
      page.on("download", (dl) => {
        const task = saveDownload(dl).catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          failures.push(reason);
          log(`ERR download: ${reason}`);
        });
        pending.add(task);
        void task.finally(() => pending.delete(task));
      });
    },
    async settled(): Promise<{ saved: DownloadRecord[]; failures: string[] }> {
      // New downloads can start while earlier ones drain, so loop until quiet.
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
      return { saved, failures };
    },
  };
}

/** One storyboard fixture, as the drivers and the manifest validation consume it. */
export interface ScenarioFixture {
  scenarioId: string;
  durationSec: number;
  fps: number;
  cameras: string[];
  beats: Array<{ id: string; tStart: number; tEnd: number; cameraHint: string }>;
  narration: Array<{ t: number; text: string }>;
  lesson: { title: string; body: string };
}

/**
 * Load and validate the committed storyboard fixtures — the registry the capture
 * UI renders from, and the ground truth every render is checked against.
 * Scenario ids come from the filenames so the registry stays single-sourced.
 */
export function loadScenarioFixtures(dir = "fixtures"): ScenarioFixture[] {
  const ids = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
  if (ids.length === 0) throw new Error(`no scenario fixtures in ${dir}`);
  return ids.map((id) => readScenarioFixture(id, dir));
}

function readScenarioFixture(scenarioId: string, dir: string): ScenarioFixture {
  const raw = JSON.parse(readFileSync(join(dir, `${scenarioId}.json`), "utf8")) as ScenarioFixture;
  if (
    raw.scenarioId !== scenarioId ||
    !Number.isFinite(raw.durationSec) ||
    !Number.isFinite(raw.fps) ||
    !Array.isArray(raw.cameras) ||
    raw.cameras.length === 0 ||
    !Array.isArray(raw.beats) ||
    !Array.isArray(raw.narration) ||
    !raw.lesson?.title ||
    !raw.lesson.body
  ) {
    throw new Error(`fixture shape invalid: ${scenarioId}`);
  }
  return raw;
}
