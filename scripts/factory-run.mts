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

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Download,
  type Page,
} from "playwright-core";
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
/**
 * Page-side probe (on by default; FACTORY_RUN_PROBE=0 disables it).
 *
 * Why: a status read of the boot string ("idle") mid-run means either the page
 * loaded a fresh document (a reload) or app code rewrote the element. The probe
 * tells them apart: a sessionStorage document counter plus
 * performance.timeOrigin proves a new document, and a Node.prototype.textContent
 * setter patch records every write to #capture-status together with the writing
 * stack. Per-frame progress writes are only counted — they fire thousands of
 * times per scenario and would drown the log.
 */
const PROBE = process.env.FACTORY_RUN_PROBE !== "0";
const PROBE_KEY = "__jn_probe_v1";
/** Cadence of the liveness heartbeat line (status + probe counters + heap). */
const HEARTBEAT_MS = Number(process.env.FACTORY_RUN_HEARTBEAT_MS ?? 20_000);
/** onProgress status shape: "<scenario>: <camera> <frame>/<total>". */
const PROGRESS_STATUS = /^[a-z0-9-]+: [a-z0-9-]+ \d+\/\d+/;

interface ProbeEntry {
  at: string;
  kind: string;
  detail: string;
}

interface ProbeTelemetry {
  /** Documents loaded in this tab so far (sessionStorage-persisted). */
  docs: number;
  firstDocAt: number;
  /** Small ring of notable page-side events (documents, status writes, errors). */
  notable: ProbeEntry[];
  statusWrites: number;
  progressWrites: number;
  /** performance.timeOrigin of the CURRENT document (epoch ms). */
  timeOrigin: number;
  heapMb: number | null;
  readyState: string;
  /** True when the textContent patch is live in the current document. */
  patched: boolean;
}

/**
 * Runs in the page, before any app script, on every document load.
 *
 * `key` is passed as an argument (not closed over): Playwright evaluates the
 * script from its source text, so module-scope constants are undefined there.
 */
function probeInit(key: string): void {
  const PROGRESS = /^[a-z0-9-]+: [a-z0-9-]+ \d+\/\d+/;
  type State = { docs: number; firstDocAt: number; notable: ProbeEntry[] };
  let state: State = { docs: 0, firstDocAt: Date.now(), notable: [] };
  try {
    const raw = sessionStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as State | null) : null;
    if (parsed && typeof parsed.docs === "number" && Array.isArray(parsed.notable)) state = parsed;
  } catch {
    // Blocked storage: the probe still works, in memory only.
  }
  const flush = (): void => {
    state.notable = state.notable.slice(-200);
    try {
      sessionStorage.setItem(key, JSON.stringify(state));
    } catch {
      // Quota/blocked storage.
    }
  };
  const record = (kind: string, detail: unknown): void => {
    const entry = { at: new Date().toISOString(), kind, detail: String(detail).slice(0, 500) };
    state.notable.push(entry);
    flush();
    try {
      console.debug("[probe]", JSON.stringify(entry));
    } catch {
      // Console unavailable (shouldn't happen).
    }
  };

  state.docs += 1;
  const win = window as unknown as { __jnProgressWrites?: number; __jnStatusWrites?: number };
  win.__jnProgressWrites = 0;
  win.__jnStatusWrites = 0;
  const nav = performance.getEntriesByType("navigation")[0] as
    PerformanceNavigationTiming | undefined;
  record(
    "document",
    `#${state.docs} navType=${nav?.type ?? "?"} timeOrigin=${Math.round(performance.timeOrigin)} startedAt=${new Date(performance.timeOrigin).toISOString()} href=${location.href}`,
  );

  window.addEventListener("pagehide", () => record("pagehide", location.href));
  window.addEventListener("beforeunload", () => record("beforeunload", location.href));
  window.addEventListener("error", (e) => record("window.error", (e as ErrorEvent).message));
  window.addEventListener("unhandledrejection", (e) =>
    record("window.unhandledrejection", String((e as PromiseRejectionEvent).reason)),
  );

  // Attribute #capture-status writes to the code that made them. A status that
  // reads "idle" without a new `document` record is app code, not a reload.
  const desc = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
  if (desc?.get && desc.set) {
    const getter = desc.get;
    const setter = desc.set;
    Object.defineProperty(Node.prototype, "textContent", {
      configurable: true,
      enumerable: desc.enumerable,
      get(this: Node): string | null {
        return getter.call(this) as string | null;
      },
      set(this: Node, value: string): void {
        if ((this as unknown as { id?: string }).id === "capture-status") {
          win.__jnStatusWrites = (win.__jnStatusWrites ?? 0) + 1;
          if (PROGRESS.test(String(value))) {
            win.__jnProgressWrites = (win.__jnProgressWrites ?? 0) + 1;
          } else {
            const stack = (new Error().stack ?? "").split("\n").slice(1, 4).join(" | ");
            record("status-write", `${JSON.stringify(String(value))} stack=${stack}`);
          }
        }
        setter.call(this, value);
      },
    });
  } else {
    record("probe-warning", "Node.prototype.textContent is not an accessor — patch skipped");
  }
}

/** Attach the page-side probe plus navigation/socket/crash logging to the page. */
async function installProbe(context: BrowserContext, page: Page): Promise<void> {
  if (!PROBE) return;
  await context.addInitScript(probeInit, PROBE_KEY);
  page.on("close", () => say("page closed"));
  page.on("crash", () => say("PAGE CRASHED (renderer process gone)"));
  page.on("load", () => say(`page load: ${page.url()}`));
  page.on("domcontentloaded", () => say(`page domcontentloaded: ${page.url()}`));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) say(`NAVIGATED (main frame): ${frame.url()}`);
  });
  page.on("websocket", (ws) => {
    say(`websocket open: ${ws.url()}`);
    ws.on("close", () => say(`websocket close: ${ws.url()}`));
    ws.on("socketerror", (err) => say(`websocket error: ${ws.url()} ${String(err)}`));
  });
}

/** Read the page-side probe state. Null when the probe is off or page is gone. */
async function probeTelemetry(page: Page): Promise<ProbeTelemetry | null> {
  if (!PROBE) return null;
  try {
    return (await page.evaluate((key: string) => {
      type State = { docs?: number; firstDocAt?: number; notable?: ProbeEntry[] };
      let state: State = {};
      try {
        state = JSON.parse(sessionStorage.getItem(key) ?? "{}") as State;
      } catch {
        // Blocked storage.
      }
      const win = window as unknown as { __jnProgressWrites?: number; __jnStatusWrites?: number };
      const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      const setter = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")?.set;
      return {
        docs: state.docs ?? 0,
        firstDocAt: state.firstDocAt ?? 0,
        notable: state.notable ?? [],
        statusWrites: win.__jnStatusWrites ?? 0,
        progressWrites: win.__jnProgressWrites ?? 0,
        timeOrigin: Math.round(performance.timeOrigin),
        heapMb: memory ? Math.round(memory.usedJSHeapSize / 1e6) : null,
        readyState: document.readyState,
        patched: typeof setter === "function" && setter.toString().includes("capture-status"),
      };
    }, PROBE_KEY)) as ProbeTelemetry;
  } catch (err) {
    say(`warn: probe telemetry unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Log probe telemetry + the notable page-side events (the reload paper trail). */
async function probeReport(page: Page, label: string, status: string): Promise<void> {
  const t = await probeTelemetry(page);
  if (!t) {
    say(`probe report (${label}): probe unavailable`);
    return;
  }
  say(
    `probe report (${label}): status="${status}" docs=${t.docs} progressWrites=${t.progressWrites} statusWrites=${t.statusWrites} heap=${t.heapMb ?? "?"}MB readyState=${t.readyState} patched=${t.patched}`,
  );
  say(
    `probe report (${label}): document timeOrigin=${t.timeOrigin} (${new Date(t.timeOrigin).toISOString()})`,
  );
  for (const entry of t.notable) say(`  probe ${entry.at} ${entry.kind}: ${entry.detail}`);
}
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
  await installProbe(context, page);
  const pageErrors: string[] = [];

  page.on("pageerror", (err) => {
    pageErrors.push(`pageerror: ${err.message}`);
    say(`ERR pageerror: ${err.message}`);
  });
  page.on("console", (m) => {
    if (m.type() !== "error" && /^\[(?:vite|probe)\]/.test(m.text())) {
      say(`console.${m.type()}: ${m.text()}`);
    }
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
  /** Log status changes with a light rate limit (progress lines fire per frame). */
  let lastLoggedStatus = "";
  let lastStatusLogAt = 0;
  const logStatus = (text: string): void => {
    if (text === lastLoggedStatus) return;
    const now = Date.now();
    if (PROGRESS_STATUS.test(text) && now - lastStatusLogAt < 15_000) return;
    lastLoggedStatus = text;
    lastStatusLogAt = now;
    say(`status: ${text}`);
  };
  let lastHeartbeat = 0;
  let lastProbe: ProbeTelemetry | null = null;

  while (Date.now() - startedAt < HARD_TIMEOUT_MS) {
    const s = ((await page.locator(STATUS).textContent()) ?? "").trim();
    if (s === lastStatus) {
      if (Date.now() - lastChange > STALL_MS && !expectedDone.test(s)) {
        await probeReport(page, "stall", s);
        throw new Error(`status stalled for >${STALL_MS}ms: "${s}"`);
      }
    } else {
      lastStatus = s;
      lastChange = Date.now();
      logStatus(s);
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
    if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
      lastHeartbeat = Date.now();
      const t = await probeTelemetry(page);
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      // A new document (or a counter that went backwards) means the page was
      // reloaded/reset mid-run: the render is gone, so fail now with the probe
      // trail instead of waiting out the stall window on a boot-string status.
      if (
        t &&
        lastProbe &&
        (t.timeOrigin !== lastProbe.timeOrigin || t.progressWrites < lastProbe.progressWrites)
      ) {
        await probeReport(page, "page-reset", lastStatus);
        throw new Error(
          `page re-initialized mid-run at +${elapsed}s (document timeOrigin ${lastProbe.timeOrigin} -> ${t.timeOrigin}, progressWrites ${lastProbe.progressWrites} -> ${t.progressWrites}); the render is no longer running`,
        );
      }
      lastProbe = t;
      say(
        `heartbeat +${elapsed}s: status="${lastStatus}" ` +
          (t
            ? `docs=${t.docs} progressWrites=${t.progressWrites} statusWrites=${t.statusWrites} heap=${t.heapMb ?? "?"}MB origin=${new Date(t.timeOrigin).toISOString()}`
            : "probe unavailable"),
      );
    }
    await page.waitForTimeout(2000);
  }

  await probeReport(page, ok ? "pass" : "timeout", lastStatus);
  await screenshot(page, "02-final");
  say(ok ? `RESULT: PASS — ${finalStatus}` : `RESULT: FAIL — ${finalStatus || "timed out"}`);
  if (!ok) throw new Error(`factory render did not finish: "${finalStatus || "timed out"}"`);

  const done = expectedDone.exec(finalStatus)!;
  const reportedSeed = Number(done[1]);
  if (reportedSeed !== ROOT_SEED) {
    throw new Error(`status seed ${reportedSeed} != requested ${ROOT_SEED}`);
  }
  // Download persistence is async (page 'download' events); the app triggers
  // clips first, then manifests, then the corpus JSONs (env/scenario/index) —
  // "the index downloads last". The final status line is printed before those
  // last downloads finish streaming, so poll for stragglers until the on-disk
  // check passes. The window must outlast the largest clip streams too (a
  // 1080p render writes multi-MB files); closing the browser early cancels
  // whatever is still in flight and leaves 0-byte placeholders.
  const drainDeadline = Date.now() + 5 * 60_000;
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
