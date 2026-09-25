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
 *
 * Browser launch, download persistence and fixture validation live in
 * `scripts/lib/capture-driver.mts`, shared with `scripts/footage.mts` (the
 * production-scale capture used to cut the launch video).
 */

import type { Browser, Page } from "playwright-core";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatBytes,
  launchCaptureBrowser,
  loadScenarioFixtures,
  trackDownloads,
} from "./lib/capture-driver.mts";

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

function validateFixtures(): void {
  const fixtures = loadScenarioFixtures();
  for (const scenarioId of EXPECTED_SCENARIOS) {
    const fixture = fixtures.find((f) => f.scenarioId === scenarioId);
    if (
      !fixture ||
      fixture.durationSec !== 50 ||
      fixture.fps !== 30 ||
      JSON.stringify(fixture.cameras) !== JSON.stringify(EXPECTED_CAMERAS)
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

async function runCaptureFlow(browser: Browser): Promise<boolean> {
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1024, height: 768 },
  });
  const page = await context.newPage();
  const tracker = trackDownloads(ARTIFACTS, say);
  tracker.attach(page);

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

  // The status line fires when the mux finalized, not when the browser has
  // finished writing the file, so let the download channel drain before the
  // context closes — otherwise the tail of the batch lands as 0-byte stubs.
  const { saved, failures } = await tracker.settled();
  if (failures.length > 0) say(`download failures: ${failures.length}`);
  say(`durable artifacts: ${saved.length} file(s) under ${ARTIFACTS}`);

  await context.close().catch(() => {});
  return ok;
}

async function main(): Promise<boolean> {
  say(`base: ${BASE_URL}`);

  const { browser, child } = await launchCaptureBrowser(say);
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
