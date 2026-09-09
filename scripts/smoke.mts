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

import { chromium, type Browser, type Page } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE_URL = process.env.SMOKE_URL ?? "http://localhost:5178";
const STATUS = "#capture-status";
const DONE_PREFIX = "saved renders/";
const HARD_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 2_400_000);
const STALL_MS = Number(process.env.SMOKE_STALL_MS ?? 240_000);
const ARTIFACTS = join("scripts", "smoke-artifacts");

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
      if (s.startsWith(DONE_PREFIX)) {
        finalStatus = s;
        ok = true;
        break;
      }
    }
    await page.waitForTimeout(2000);
  }

  await screenshot(page, "03-final");
  say(ok ? `RESULT: PASS — ${finalStatus}` : "RESULT: FAIL — timed out");
  if (pageErrors.length > 0) say(`page/console errors observed: ${pageErrors.length}`);

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
