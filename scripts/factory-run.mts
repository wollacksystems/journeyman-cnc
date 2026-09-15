/**
 * Headless CI driver for the factory render flow.
 *
 * Produces a generated corpus end-to-end in Chromium without the dev UI:
 * loads the preview server, fills the factory controls (seed / envs / perEnv),
 * triggers RENDER FACTORY, waits for the final on-page status line
 * "saved corpora/<rootSeedPadded10>: N scenarios, M clips + index.json", then
 * validates the exported corpus on disk (index.json schema + every referenced
 * artifact present and non-empty).
 *
 * Same browser strategy as scripts/smoke.mts: Playwright-managed Chromium
 * (npx playwright-core install chromium, once), with the CDP-over-HTTP
 * fallback for machines where chromium.launch hangs (set SMOKE_USE_CDP=1).
 *
 * Usage: node scripts/factory-run.mts
 *   FACTORY_RUN_URL      preview server base (default http://localhost:5178)
 *   FACTORY_RUN_SEED     root seed to plan (default 2026)
 *   FACTORY_RUN_ENVS     generated environments (default 2)
 *   FACTORY_RUN_PER_ENV  scenarios per environment (default 3 = every template)
 *   FACTORY_RUN_DIR      durable output dir (default scripts/factory-artifacts)
 *   FACTORY_TIMEOUT_MS / FACTORY_STALL_MS for the wait loop
 * Requires Node 23.6+.
 */

import { chromium, type Browser, type Download, type Page } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const BASE_URL = process.env.FACTORY_RUN_URL ?? "http://localhost:5178";
const STATUS = "#capture-status";
const ROOT_SEED = Number(process.env.FACTORY_RUN_SEED ?? 2026);
const ENV_COUNT = Math.max(1, Number(process.env.FACTORY_RUN_ENVS ?? 2));
const PER_ENV = Math.max(1, Number(process.env.FACTORY_RUN_PER_ENV ?? 3));
const ARTIFACTS = join("scripts", "factory-artifacts");
const HARD_TIMEOUT_MS = Number(process.env.FACTORY_TIMEOUT_MS ?? 2_400_000);
const STALL_MS = Number(process.env.FACTORY_STALL_MS ?? 240_000);
/** Final on-page status emitted by main.ts factoryFlow after saveCorpus. */
const DONE_PATTERN =
  /^saved corpora\/(\d{10}): (\d+) scenarios, (\d+) clips \+ index\.json \(seed (\d+)\)$/;

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * Chromium flattens slashes in download names: "corpora/<seed>/envs/env-00.json"
 * arrives as "corpora_<seed>_envs_env-00.json". Scenario ids and cameras use
 * hyphens only, so underscores are exactly the directory separators.
 */
function structuredPath(suggested: string): string {
  const flat = suggested.replace(/\\/g, "/");
  const match = /^corpora_(\d+)_(.+)$/.exec(flat);
  if (!match) return flat;
  const [, seed, rest] = match;
  const parts = rest.split("_");
  // Root-level files (index.json) have no directory segment after the seed.
  if (parts.length === 1) return `corpora/${seed}/${parts[0]}`;
  return `corpora/${seed}/${parts[0]}/${parts.slice(1).join("/")}`;
}

/** Persist one browser download to the durable artifacts dir. */
async function saveDownload(dl: Download): Promise<{ rel: string; size: number }> {
  const rel = structuredPath(dl.suggestedFilename() ?? "download.bin");
  const dest = join(ARTIFACTS, rel);
  mkdirSync(dirname(dest), { recursive: true });
  const out = createWriteStream(dest);
  const stream = await dl.createReadStream();
  if (!stream) throw new Error(`empty download stream for ${dl.suggestedFilename()}`);
  await new Promise<void>((resolve, reject) => {
    stream.pipe(out);
    out.on("finish", () => resolve());
    out.on("error", reject);
    stream.on("error", reject);
  });
  return { rel, size: statSync(dest).size };
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
    writeFileSync(join(ARTIFACTS, "factory-run.log"), log.join("\n") + "\n");
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
  const profile = join(tmpdir(), `journeyman-factory-cdp-${process.pid}`);
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

/** Minimal index shape the driver validates against (schema-tolerant). */
interface CorpusIndexLike {
  schema?: string;
  schemaVersion?: number;
  rootSeed?: number;
  scenarios?: Array<{
    scenarioId?: string;
    envId?: string;
    seed?: number;
    clips?: Record<string, string>;
    manifest?: string;
    script?: string;
    lesson?: { title?: string; body?: string };
  }>;
  environments?: Array<{ envId?: string; spec?: string; scenarioIds?: string[] }>;
}

/** Validate the exported corpus on disk: index schema + every artifact present. */
function validateCorpus(rootSeed: number, expectedScenarios: number): void {
  const corpusRoot = join(ARTIFACTS, "corpora", rootSeed.toString().padStart(10, "0"));
  const indexPath = join(corpusRoot, "index.json");
  if (!existsSync(indexPath)) throw new Error(`corpus index missing: ${indexPath}`);
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as CorpusIndexLike;

  if (index.schema !== "journeyman-corpus-index" || index.schemaVersion !== 1) {
    throw new Error(`corpus index schema mismatch: ${index.schema} v${index.schemaVersion}`);
  }
  if (index.rootSeed !== rootSeed) {
    throw new Error(`corpus rootSeed mismatch: ${index.rootSeed} != ${rootSeed}`);
  }
  const scenarios = index.scenarios ?? [];
  if (scenarios.length !== expectedScenarios) {
    throw new Error(`corpus scenario count: ${scenarios.length} != ${expectedScenarios}`);
  }

  let clips = 0;
  const requireFile = (rel: string | undefined, what: string): void => {
    if (!rel) throw new Error(`index entry missing ${what} path`);
    const p = join(ARTIFACTS, rel);
    if (!existsSync(p)) throw new Error(`corpus artifact missing: ${rel}`);
    const size = statSync(p).size;
    if (size === 0) throw new Error(`corpus artifact empty: ${rel}`);
  };
  for (const entry of scenarios) {
    if (!entry.scenarioId || !entry.envId || typeof entry.seed !== "number") {
      throw new Error(`incomplete scenario entry: ${JSON.stringify(entry).slice(0, 120)}`);
    }
    if (!entry.lesson?.title || !entry.lesson?.body) {
      throw new Error(`scenario entry missing lesson: ${entry.scenarioId}`);
    }
    requireFile(entry.script, "script");
    requireFile(entry.manifest, "manifest");
    for (const [camera, rel] of Object.entries(entry.clips ?? {})) {
      requireFile(rel, `clip ${camera}`);
      clips += 1;
    }
  }
  for (const env of index.environments ?? []) {
    requireFile(env.spec, `env spec ${env.envId}`);
  }
  say(
    `corpus ok: corpora/${rootSeed.toString().padStart(10, "0")} — ${scenarios.length} scenarios, ${clips} clips, all index artifacts present`,
  );
}

async function runFactoryFlow(browser: Browser): Promise<boolean> {
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

  let saved = 0;
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

  say(`base: ${BASE_URL}`);
  say(`plan: seed ${ROOT_SEED}, ${ENV_COUNT} envs x ${PER_ENV} scenarios`);
  await page.goto(BASE_URL, { waitUntil: "load", timeout: 60_000 });
  await page.locator("#rig").waitFor({ state: "visible", timeout: 20_000 });
  await page.locator(STATUS).waitFor({ state: "visible", timeout: 20_000 });
  await page
    .getByRole("button", { name: "RENDER FACTORY" })
    .waitFor({ state: "visible", timeout: 20_000 });
  say("ui ok: factory controls visible");

  // Configure the run through the factory panel.
  await page.locator("#factory-seed").fill(String(ROOT_SEED));
  await page.locator("#factory-envs").fill(String(ENV_COUNT));
  await page.locator("#factory-per-env").fill(String(PER_ENV));

  // Plan first so the status line confirms the corpus shape before rendering.
  await page.getByRole("button", { name: "PLAN FACTORY" }).click();
  const plannedPattern = new RegExp(
    `^planned seed ${ROOT_SEED}: ${ENV_COUNT * PER_ENV} scenarios across ${ENV_COUNT} envs`,
  );
  await page
    .locator(STATUS)
    .filter({ hasText: plannedPattern })
    .waitFor({ state: "visible", timeout: 20_000 });
  say(`plan ok: ${ENV_COUNT * PER_ENV} scenarios across ${ENV_COUNT} envs`);
  await screenshot(page, "00-planned");

  say("clicking RENDER FACTORY...");
  await page.getByRole("button", { name: "RENDER FACTORY" }).click();
  await page.waitForTimeout(1500);
  await screenshot(page, "01-render-start");

  const expectedDone = DONE_PATTERN;
  const startedAt = Date.now();
  let lastStatus = "";
  let lastChange = Date.now();
  let lastScenario = "";
  let finalStatus = "";
  let ok = false;

  while (Date.now() - startedAt < HARD_TIMEOUT_MS) {
    const s = ((await page.locator(STATUS).textContent()) ?? "").trim();
    if (s === lastStatus) {
      if (Date.now() - lastChange > STALL_MS && !expectedDone.test(s)) {
        throw new Error(`status stalled for >${STALL_MS}ms: "${s}"`);
      }
    } else {
      lastStatus = s;
      lastChange = Date.now();
      if (s.startsWith("factory failed:")) throw new Error(s);
      const scenario = /^([a-z0-9-]+): [a-z0-9-]+ \d+\/\d+/.exec(s)?.[1] ?? "";
      if (scenario && scenario !== lastScenario) {
        lastScenario = scenario;
        say(`scenario start: ${scenario}`);
      }
      if (s.startsWith("exporting corpus")) say(`status: ${s}`);
      const done = expectedDone.exec(s);
      if (done) {
        finalStatus = s;
        ok = true;
        break;
      }
    }
    await page.waitForTimeout(2000);
  }

  await screenshot(page, "02-final");
  say(ok ? `RESULT: PASS — ${finalStatus}` : `RESULT: FAIL — ${finalStatus || "timed out"}`);
  if (!ok) throw new Error(`factory render did not finish: "${finalStatus || "timed out"}"`);

  const done = expectedDone.exec(finalStatus)!;
  const reportedSeed = Number(done[1]);
  if (reportedSeed !== ROOT_SEED) {
    throw new Error(`status seed ${reportedSeed} != requested ${ROOT_SEED}`);
  }
  // Download persistence is async (page 'download' events) and downloads
  // usually land well before the final status; poll briefly for stragglers
  // so the on-disk check never races the writer.
  const drainDeadline = Date.now() + 60_000;
  let lastErr: Error | null = null;
  while (Date.now() < drainDeadline) {
    try {
      validateCorpus(ROOT_SEED, ENV_COUNT * PER_ENV);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
    await page.waitForTimeout(1000);
  }
  if (lastErr) throw lastErr;

  if (pageErrors.length > 0) say(`page/console errors observed: ${pageErrors.length}`);
  say(`durable artifacts: ${saved} file(s) under ${ARTIFACTS}`);

  await context.close().catch(() => {});
  return ok;
}

async function main(): Promise<boolean> {
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
    return await runFactoryFlow(browser);
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
  .catch((err) => {
    say(`FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    saveLog();
    process.exit(1);
  });
