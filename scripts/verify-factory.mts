/**
 * Headless deterministic proof for the factory layer: seeded planning,
 * generated scenario validity, provenance manifests, and the environment
 * binding that lets templates run in any generated environment.
 */
import { planFactory } from "../src/factory/plan.ts";
import {
  generateScenario,
  scenarioSeedFor,
  TEMPLATE_IDS,
  TEMPLATE_REGISTRY,
} from "../src/factory/scenario-gen.ts";
import { generateEnvironment, LOCKED_ENV, toWorld } from "../src/factory/environment.ts";
import { buildFactoryManifest } from "../src/factory/manifest.ts";
import {
  buildCorpusIndex,
  buildScenarioScriptDoc,
  clipManifestPath,
  clipPath,
  corpusDirName,
  corpusIndexPath,
  corpusJson,
  corpusRootPath,
  envSpecPath,
  scenarioScriptPath,
} from "../src/factory/corpus.ts";
import { createRng } from "../src/factory/rng.ts";
import { createMachineCell } from "../src/cell.ts";
import { CameraRig } from "../src/rig.ts";
import { driveScenario } from "../src/scenario/drive.ts";
import { validateScenario } from "../src/scenario/types.ts";
import { ENGINE_VERSION } from "../src/version.ts";
import * as factoryApi from "../src/factory/index.ts";
import type { FactoryWorld } from "../src/factory/world.ts";
import {
  iterTrainingTuples,
  readCorpusIndex,
  readScenarioScript,
  validateCorpusIndex,
  type CorpusFilesystem,
} from "../src/factory/corpus-read.ts";

let failures = 0;
function check(name: string, condition: boolean, detail: string): void {
  if (condition) console.log(`[PASS] ${name}: ${detail}`);
  else {
    failures += 1;
    console.error(`[FAIL] ${name}: ${detail}`);
  }
}

// 1. Planning is a pure function of (seed, options).
const planA = planFactory(2026, { envCount: 3, perEnv: 2 });
const planB = planFactory(2026, { envCount: 3, perEnv: 2 });
check(
  "planning is deterministic",
  JSON.stringify(planA) === JSON.stringify(planB),
  `seed ${planA.rootSeed}, ${planA.jobs.length} jobs`,
);
check(
  "plan shape matches options",
  planA.envCount === 3 && planA.perEnv === 2 && planA.jobs.length === 6,
  `${planA.envCount} envs x ${planA.perEnv} scenarios = ${planA.jobs.length} jobs`,
);
const distinctPlans = JSON.stringify(planFactory(7)) !== JSON.stringify(planFactory(8));
check("distinct seeds diverge", distinctPlans, "seed 7 vs 8 plans differ");

// 2. Every generated job is a valid, corpus-shaped scenario with unique ids.
const ids = new Set<string>();
let allValid = true;
let allCorpusShaped = true;
for (const job of planA.jobs) {
  const problems = validateScenario(job.scenario);
  if (problems.length > 0) allValid = false;
  if (
    job.scenario.cameras.length !== 4 ||
    job.scenario.cameras.join(",") !== "side-a,side-b,head,chest" ||
    job.scenario.durationSec < 45 ||
    job.scenario.durationSec > 60 ||
    job.scenario.beats.length === 0 ||
    job.scenario.narration.length === 0 ||
    job.scenario.lesson.title.length === 0
  ) {
    allCorpusShaped = false;
  }
  ids.add(job.scenario.id);
}
check("generated scenarios validate", allValid, "zero validateScenario problems");
check(
  "generated scenarios match corpus shape",
  allCorpusShaped,
  "4 production cameras, 45-60s, beats + narration + lesson",
);
check("scenario ids unique", ids.size === planA.jobs.length, `${ids.size} unique ids`);

// 2b. All three failure-mode templates participate and generate validly.
check(
  "template registry covers locked failure modes",
  TEMPLATE_IDS.join(",") === "sensor-trip,way-lube,atc-jam" &&
    Object.keys(TEMPLATE_REGISTRY).length === 3,
  TEMPLATE_IDS.join(","),
);
const fullPlan = planFactory(11, { envCount: 1, perEnv: 3 });
const fullTemplates = new Set(fullPlan.jobs.map((job) => job.scenario.templateId));
check(
  "perEnv cycles through every template",
  fullPlan.jobs.length === 3 && fullTemplates.size === 3,
  [...fullTemplates].join(","),
);
for (const job of fullPlan.jobs) {
  const problems = validateScenario(job.scenario);
  check(
    `${job.scenario.id} (${job.scenario.templateId}) validates`,
    problems.length === 0,
    problems.join("; ") || "zero problems",
  );
}

// 3. Scenario generation depends only on (env seed, env id, template, slot).
const standalone = planA.jobs.map((job) =>
  generateScenario(job.env, job.scenario.templateId, 50, job.scenario.slot),
);
const standaloneMatches = planA.jobs.every(
  (job, i) => JSON.stringify(job.scenario) === JSON.stringify(standalone[i]),
);
check(
  "scenario seeds derive from (env, template)",
  standaloneMatches,
  "in-plan scenarios equal standalone regeneration",
);

// 3b. Cell-state transitions match each template's failure mode (headless drive).
const byTemplate = new Map(fullPlan.jobs.map((job) => [job.scenario.templateId, job.scenario]));
const trip = byTemplate.get("sensor-trip")!;
const lube = byTemplate.get("way-lube")!;
const jam = byTemplate.get("atc-jam")!;
// sensor-trip: dust present mid-scenario, gone after its clearedAt.
const tripMid = driveScenario(trip, (trip.cell.dust!.appearsAt + trip.cell.dust!.clearedAt) / 2);
const tripEnd = driveScenario(trip, trip.cell.dust!.clearedAt + 2);
check(
  "generated sensor-trip dust transitions",
  tripMid.cell.dust === 1 && tripEnd.cell.dust === 0,
  `${tripMid.cell.dust} -> ${tripEnd.cell.dust}`,
);
// way-lube: leak rises, then wipes away.
const lubeMid = driveScenario(
  lube,
  (lube.cell.wayLube!.appearsAt + lube.cell.wayLube!.clearedAt) / 2,
);
const lubeEnd = driveScenario(lube, lube.cell.wayLube!.clearedAt + 2);
check(
  "generated way-lube leak transitions",
  lubeMid.cell.wayLube === 1 && lubeEnd.cell.wayLube === 0,
  `${lubeMid.cell.wayLube} -> ${lubeEnd.cell.wayLube}`,
);
// atc-jam: carousel frozen mid-scenario, rotating again after the clear.
const jamMid = driveScenario(jam, (jam.cell.atc!.appearsAt + jam.cell.atc!.clearedAt) / 2);
const jamEnd = driveScenario(jam, jam.cell.atc!.clearedAt + 2);
check(
  "generated atc-jam freezes + releases the carousel",
  jamMid.cell.atcJammed === 1 &&
    jamEnd.cell.atcJammed === 0 &&
    jamEnd.cell.atcRotation > jamMid.cell.atcRotation,
  `jam=${jamMid.cell.atcRotation.toFixed(2)} post=${jamEnd.cell.atcRotation.toFixed(2)}`,
);
// Signal stacks end green for every generated failure mode.
check(
  "generated scenarios end green",
  [trip, lube, jam].every((s) => {
    const end = driveScenario(s, s.durationSec - 0.1);
    return end.cell.signal.green === 1 && end.cell.signal.red === 0;
  }),
  "red -> amber -> green on all three",
);

// 3c. ATC anchors mirror with the environment's ATC side; other templates hold.
const envLeft = { ...fullPlan.jobs[0]!.env, atcSide: -1 as const };
const jamLeft = generateScenario(envLeft, "atc-jam");
const jamRight = generateScenario({ ...envLeft, atcSide: 1 }, "atc-jam");
check(
  "atc-jam anchors flip with atcSide",
  jamLeft.faultWorld[0] === -jamRight.faultWorld[0] &&
    jamLeft.faultWorld[1] === jamRight.faultWorld[1] &&
    jamLeft.faultWorld[2] === jamRight.faultWorld[2] &&
    jamLeft.faultWorld[0] < 0,
  `left ${jamLeft.faultWorld.map((v) => v.toFixed(2))} vs right ${jamRight.faultWorld.map((v) => v.toFixed(2))}`,
);
check(
  "cell builder mirrors the pod to match",
  createMachineCell({ atcSide: -1 }).atc.position.x < 0,
  `pod x ${createMachineCell({ atcSide: -1 }).atc.position.x.toFixed(2)}`,
);

// 3d. Repeated templates in one environment (slots) genuinely diverge.
const slotPlan = planFactory(42, { envCount: 1, perEnv: 6 });
const slotScenarios = slotPlan.jobs.map((job) => job.scenario);
// Both slot-0 and slot-3 cycle back to sensor-trip: their beat timings and
// narration must differ (seeded per slot).
const slotTripA = slotScenarios[0]!;
const slotTripB = slotScenarios[3]!;
const distinctLessons = new Set(slotScenarios.map((s) => s.lesson.body));
check(
  "slot repeats diverge in timing and narration",
  slotPlan.jobs.length === 6 &&
    slotTripA.templateId === "sensor-trip" &&
    slotTripB.templateId === "sensor-trip" &&
    JSON.stringify(slotTripA.beats) !== JSON.stringify(slotTripB.beats) &&
    distinctLessons.size >= 2,
  `slot 0/3 timings differ, ${distinctLessons.size} distinct lessons across 6 slot scenarios`,
);

// 4. Environment binding: sensor-trip world anchors equal the machine-frame
// mapping (the template whose anchors are front-fixed, not ATC-relative).
let bindingHolds = true;
for (const job of planA.jobs) {
  if (job.scenario.templateId !== "sensor-trip") continue;
  const expected = toWorld(job.env, [0.42, 1.02, 0.4]); // guard sensor face anchor
  const got = job.scenario.faultWorld;
  if (expected.some((v, i) => Math.abs(v - got[i]) > 1e-9)) bindingHolds = false;
}
check(
  "fault anchor equals toWorld(machine frame)",
  bindingHolds,
  "faultWorld == toWorld(env, [0.42, 1.02, 0.4]) for sensor-trip jobs",
);

// 5. Environments actually vary (fixed seeds -> fully deterministic check).
const envs = Array.from({ length: 8 }, (_, i) => generateEnvironment(i + 1, i, createRng(i + 1)));
const rotations = new Set(envs.map((e) => e.machineRotation.toFixed(6)));
const palettes = new Set(envs.map((e) => e.palette.name));
const sides = new Set(envs.map((e) => e.atcSide));
check(
  "environments vary orientation/palette/ATC side",
  rotations.size > 1 && palettes.size > 1 && sides.size > 1,
  `${rotations.size} rotations, ${palettes.size} palettes, ${sides.size} ATC sides over 8 seeds`,
);

// 6. Provenance manifests carry environment + factory blocks.
const rig = new CameraRig();
const sample = planA.jobs[0]!;
const manifest = buildFactoryManifest(sample, rig, 1920, 1080, "2026-01-01T00:00:00.000Z", 2026);
check(
  "manifest environment block",
  manifest.environment.id === sample.env.id &&
    manifest.environment.seed === sample.env.seed &&
    manifest.environment.palette === sample.env.palette.name,
  `${manifest.environment.id} seed ${manifest.environment.seed} (${manifest.environment.palette})`,
);
check(
  "manifest factory block",
  manifest.factory.generator === "journeyman-sim factory" &&
    manifest.factory.rootSeed === 2026 &&
    manifest.factory.templateId === sample.scenario.templateId &&
    manifest.factory.engineVersion === ENGINE_VERSION,
  `rootSeed ${manifest.factory.rootSeed}, template ${manifest.factory.templateId}, engine ${manifest.factory.engineVersion}`,
);
check(
  "manifest timeline mirrors scenario",
  manifest.timeline.beats.length === sample.scenario.beats.length &&
    manifest.timeline.narration.length === sample.scenario.narration.length &&
    manifest.lesson.title === sample.scenario.lesson.title,
  `${manifest.timeline.beats.length} beats, ${manifest.timeline.narration.length} lines`,
);

// 7. LOCKED_ENV + spec-driven cell reproduce the locked Phase-0 look.
check(
  "LOCKED_ENV is the identity environment",
  LOCKED_ENV.machineRotation === 0 &&
    LOCKED_ENV.atcSide === 1 &&
    LOCKED_ENV.palette.name === "graphite",
  `rotation 0, ATC +X, palette ${LOCKED_ENV.palette.name}`,
);
const defaultCell = createMachineCell();
const mirroredCell = createMachineCell({ atcSide: -1 });
check(
  "cell builder honors atcSide",
  defaultCell.atc.position.x > 0 && mirroredCell.atc.position.x < 0,
  `default ${defaultCell.atc.position.x.toFixed(2)}, mirrored ${mirroredCell.atc.position.x.toFixed(2)}`,
);

// 8. Corpus export layer: stable paths, complete index, seeds that replay.
const corpusPlan = planFactory(777, { envCount: 2, perEnv: 3 });
check(
  "corpus dir pads seeds for lexical order",
  corpusDirName(777) === "0000000777" && corpusRootPath(777) === "corpora/0000000777",
  corpusRootPath(777),
);
check(
  "corpus paths are stable functions of ids",
  clipPath(5, "atc-jam-env-00", "head") === "corpora/0000000005/clips/atc-jam-env-00/head.mp4" &&
    scenarioScriptPath(5, "atc-jam-env-00") ===
      "corpora/0000000005/scenarios/atc-jam-env-00.json" &&
    envSpecPath(5, "env-00") === "corpora/0000000005/envs/env-00.json" &&
    clipManifestPath(5, "atc-jam-env-00") ===
      "corpora/0000000005/clips/atc-jam-env-00/manifest.json" &&
    corpusIndexPath(5) === "corpora/0000000005/index.json",
  "envs/ scenarios/ clips/ under the padded root",
);

const clipsByScenario: Record<string, string[]> = {};
for (const job of corpusPlan.jobs) {
  clipsByScenario[job.scenario.id] = [...job.scenario.cameras];
}
const index = buildCorpusIndex({
  plan: corpusPlan,
  clipsByScenario,
  exportedUtc: "2026-01-01T00:00:00.000Z",
});
check(
  "index identity + plan provenance",
  index.schema === "journeyman-corpus-index" &&
    index.schemaVersion === 1 &&
    index.rootSeed === 777 &&
    index.plan.envCount === 2 &&
    index.plan.perEnv === 3 &&
    index.engineVersion === ENGINE_VERSION,
  `seed ${index.rootSeed}, ${index.plan.envCount}x${index.plan.perEnv}, engine ${index.engineVersion}`,
);
check(
  "index covers every job exactly once",
  index.scenarios.length === corpusPlan.jobs.length &&
    index.environments.length === 2 &&
    index.environments.reduce((n, e) => n + e.scenarioIds.length, 0) === corpusPlan.jobs.length,
  `${index.environments.length} envs, ${index.scenarios.length} scenarios`,
);
let indexPathsOk = true;
for (const entry of index.scenarios) {
  const cameras = Object.keys(entry.clips);
  if (
    entry.clips["side-a"] !== clipPath(777, entry.scenarioId, "side-a") ||
    entry.manifest !== clipManifestPath(777, entry.scenarioId) ||
    entry.script !== scenarioScriptPath(777, entry.scenarioId) ||
    cameras.length !== 4
  ) {
    indexPathsOk = false;
  }
  const env = index.environments.find((e) => e.envId === entry.envId);
  if (!env || env.spec !== envSpecPath(777, entry.envId)) indexPathsOk = false;
}
check(
  "index artifact paths all resolve through the layout functions",
  indexPathsOk,
  "script + manifest + 4 clips + env spec per entry",
);
const seedReplay = index.scenarios.every((entry) => {
  const job = corpusPlan.jobs.find((j) => j.scenario.id === entry.scenarioId);
  return (
    job !== undefined &&
    entry.seed === scenarioSeedFor(job.env, job.scenario.templateId, job.scenario.slot) &&
    JSON.stringify(generateScenario(job.env, job.scenario.templateId, 50, job.scenario.slot)) ===
      JSON.stringify(job.scenario)
  );
});
check(
  "index seeds replay their scenarios",
  seedReplay,
  "entry.seed regenerates the exact script for every scenario",
);
const lessonOk = index.scenarios.every((entry) => {
  const job = corpusPlan.jobs.find((j) => j.scenario.id === entry.scenarioId);
  return (
    job !== undefined &&
    entry.lesson.title === job.scenario.lesson.title &&
    entry.lesson.body === job.scenario.lesson.body
  );
});
check(
  "index carries lessons for ingest labels",
  lessonOk,
  "lesson.title/body match the generated scripts",
);
const scriptDoc = buildScenarioScriptDoc(corpusPlan.jobs[0]!, 777);
check(
  "script docs carry generation provenance",
  scriptDoc.provenance.rootSeed === 777 &&
    scriptDoc.provenance.envId === corpusPlan.jobs[0]!.env.id &&
    scriptDoc.provenance.seed ===
      scenarioSeedFor(
        corpusPlan.jobs[0]!.env,
        corpusPlan.jobs[0]!.scenario.templateId,
        corpusPlan.jobs[0]!.scenario.slot,
      ) &&
    scriptDoc.provenance.templateId === corpusPlan.jobs[0]!.scenario.templateId,
  `root 777, env ${scriptDoc.provenance.envId}, seed ${scriptDoc.provenance.seed}`,
);
// ExportedUtc must not leak into any computed path (overwrite-in-place).
const indexA = buildCorpusIndex({
  plan: corpusPlan,
  clipsByScenario,
  exportedUtc: "2026-01-01T00:00:00.000Z",
});
const indexB = buildCorpusIndex({
  plan: corpusPlan,
  clipsByScenario,
  exportedUtc: "2030-06-15T12:00:00.000Z",
});
check(
  "re-export overwrites in place (paths ignore time)",
  JSON.stringify({ ...indexA, exportedUtc: "" }) === JSON.stringify({ ...indexB, exportedUtc: "" }),
  "identical modulo exportedUtc",
);
check(
  "corpus json is stable + terminated",
  corpusJson({ b: 1, a: 2 }) === '{\n  "b": 1,\n  "a": 2\n}\n',
  "2-space pretty print with trailing newline",
);

// ---------------------------------------------------------------------------
// Public API contract (issue #9): the createSimulation facade + barrel are
// the package surface. These checks run the barrel through plain Node — the
// import itself proves the pure layers stay headless-safe (no eager DOM,
// WebGL, or import.meta.env access), which the lazy facade loading provides.
// ---------------------------------------------------------------------------
const sim = factoryApi.createSimulation({ seed: 2026, shape: { envCount: 2, perEnv: 3 } });
const facadePlan = sim.plan();
const directPlan = planFactory(2026, { envCount: 2, perEnv: 3 });
check(
  "facade plan() matches planFactory exactly",
  JSON.stringify(facadePlan) === JSON.stringify(directPlan),
  `${facadePlan.jobs.length} jobs, seed ${facadePlan.rootSeed}`,
);
const described = sim.describe();
check(
  "facade describe() summarizes the plan as pure data",
  described.scenarioCount === 6 &&
    described.environments.length === 2 &&
    described.environments.every((e) => e.scenarios.length === 3) &&
    described.environments[0]!.scenarios[0]!.lesson.length > 0,
  `6 scenarios / 2 envs; first lesson "${described.environments[0]!.scenarios[0]!.lesson}"`,
);
check(
  "same spec -> byte-identical describe() (determinism through the facade)",
  JSON.stringify(
    factoryApi.createSimulation({ seed: 2026, shape: { envCount: 2, perEnv: 3 } }).describe(),
  ) === JSON.stringify(described),
  "two handles, identical summaries",
);
check(
  "spec is JSON-serializable and replays through the facade",
  JSON.stringify(
    factoryApi.createSimulation(JSON.parse(JSON.stringify(sim.spec)) as typeof sim.spec).describe(),
  ) === JSON.stringify(described),
  "JSON round-trip preserves the corpus",
);
const normalized = factoryApi.createSimulation({
  seed: -5,
  shape: { envCount: 0, perEnv: Number.NaN },
});
check(
  "spec is normalized (shape floors at 1, seed unsigned)",
  normalized.spec.shape.envCount === 1 &&
    normalized.spec.shape.perEnv === 1 &&
    normalized.spec.seed === 4294967291 &&
    normalized.plan().jobs.length === 1,
  `seed ${normalized.spec.seed}, 1x1 corpus`,
);
const requiredExports = [
  "createSimulation",
  "planFactory",
  "DEFAULT_FACTORY_OPTIONS",
  "TEMPLATE_IDS",
  "TEMPLATE_REGISTRY",
  "generateScenario",
  "scenarioSeedFor",
  "generateEnvironment",
  "LOCKED_ENV",
  "ENV_PALETTES",
  "buildCorpusIndex",
  "buildScenarioScriptDoc",
  "corpusDirName",
  "corpusJson",
  "createRng",
  "hashSeed",
];
const missingExports = requiredExports.filter((k) => !(k in factoryApi));
check(
  "barrel exposes the documented public surface",
  missingExports.length === 0,
  missingExports.length === 0
    ? `${requiredExports.length} exports present`
    : `missing: ${missingExports.join(", ")}`,
);
check(
  "barrel hides engine internals behind the handle",
  !("renderFactoryJob" in factoryApi) &&
    !("saveCorpus" in factoryApi) &&
    !("createFactoryWorld" in factoryApi) &&
    typeof sim.render === "function" &&
    typeof sim.export === "function" &&
    typeof sim.renderAndExport === "function",
  "engine values unexported; effectful methods on the handle",
);
{
  // Preview is the pure step-through affordance: applies one planned env,
  // disposer restores. Exercised against a recording stub world.
  const applied: string[] = [];
  const stubWorld = {
    env: LOCKED_ENV,
    setEnv(env: typeof LOCKED_ENV): void {
      applied.push(env.id);
    },
  } as unknown as FactoryWorld;
  const restore = sim.preview(stubWorld, 0);
  const appliedJob = applied[applied.length - 1];
  const previewOk = applied.length === 1 && appliedJob === facadePlan.jobs[0]!.env.id;
  restore();
  check(
    "preview applies the indexed planned environment",
    previewOk,
    `applied [${applied.join(", ")}] before dispose`,
  );
  check(
    "preview disposer restores the previous environment",
    applied[applied.length - 1] === LOCKED_ENV.id,
    `back to ${LOCKED_ENV.id}`,
  );
}

// ---------------------------------------------------------------------------
// Ingest reader (issues #8/#9): validate exported indexes and stream typed
// training tuples without knowing the on-disk layout. The in-memory map
// below doubles as the browser-side CorpusFilesystem adapter example; the
// disk check at the end exercises the Node adapter against a real export.
// ---------------------------------------------------------------------------
const readerIndex = buildCorpusIndex({
  plan: corpusPlan,
  clipsByScenario,
  exportedUtc: "2026-09-15T00:00:00.000Z",
});
const readerJson = corpusJson(readerIndex);
const memFiles = new Map<string, string>([
  [corpusIndexPath(777), readerJson],
  ...corpusPlan.jobs.map(
    (job) =>
      [
        scenarioScriptPath(777, job.scenario.id),
        corpusJson(buildScenarioScriptDoc(job, 777)),
      ] as const,
  ),
]);
const memFs: CorpusFilesystem = {
  readFile: async (p) => {
    const hit = memFiles.get(p);
    if (hit === undefined) throw new Error(`missing: ${p}`);
    return hit;
  },
};
const readValidation = await readCorpusIndex(memFs, corpusIndexPath(777));
check(
  "reader validates a freshly built index",
  readValidation.ok && readValidation.index !== null,
  readValidation.ok
    ? `${readValidation.problems.length} problems in ${readerIndex.scenarios.length}-scenario index`
    : readValidation.problems.map((p) => `${p.at}: ${p.message}`).join("; "),
);
const readerTuples = readValidation.index ? [...iterTrainingTuples(readValidation.index)] : [];
check(
  "tuples stream per scenario in plan order with complete data",
  readerTuples.length === corpusPlan.jobs.length &&
    readerTuples.every(
      (t, i) =>
        t.scenarioId === corpusPlan.jobs[i]!.scenario.id &&
        t.rootSeed === 777 &&
        t.env.envId === corpusPlan.jobs[i]!.env.id &&
        Object.keys(t.clips).length === 4 &&
        t.lesson.title.length > 0 &&
        t.seed > 0,
    ),
  `${readerTuples.length} tuples, 4 clips each`,
);
{
  // The tuple's seed must regenerate the exported script exactly.
  const firstTuple = readerTuples[0]!;
  const doc = await readScenarioScript(memFs, firstTuple);
  const job0 = corpusPlan.jobs[0]!;
  const regenerated = generateScenario(job0.env, firstTuple.templateId, 50, job0.scenario.slot);
  check(
    "tuple seed replays its exported script (regeneration identity)",
    doc.provenance.seed === firstTuple.seed &&
      doc.provenance.rootSeed === 777 &&
      doc.provenance.seed ===
        scenarioSeedFor(job0.env, firstTuple.templateId, job0.scenario.slot) &&
      JSON.stringify(doc.beats) === JSON.stringify(regenerated.beats),
    `seed ${firstTuple.seed}, template ${firstTuple.templateId}`,
  );
}
{
  // Mutation battery: every corruption class the validator exists for.
  const tampered = (mutate: (doc: Record<string, unknown>) => void): string => {
    const clone = JSON.parse(readerJson) as Record<string, unknown>;
    mutate(clone);
    return validateCorpusIndex(JSON.stringify(clone)).ok ? "MISSED" : "caught";
  };
  const scenarioAt = (d: Record<string, unknown>): Record<string, unknown> =>
    (d["scenarios"] as Record<string, unknown>[])[0]!;
  const results = [
    tampered((d) => {
      d["schema"] = "other-corpus";
    }),
    tampered((d) => {
      d["schemaVersion"] = 2;
    }),
    tampered((d) => {
      (d["scenarios"] as unknown[]).splice(0, 1);
    }),
    tampered((d) => {
      scenarioAt(d)["seed"] = -1;
    }),
    tampered((d) => {
      scenarioAt(d)["envId"] = "env-nope";
    }),
    tampered((d) => {
      scenarioAt(d)["script"] = "corpora/0000000777/scenarios/../../etc/passwd";
    }),
    tampered((d) => {
      scenarioAt(d)["manifest"] = "renders/other.json";
    }),
    tampered((d) => {
      scenarioAt(d)["clips"] = { front: "corpora/0000000777/clips/wrong/front.mp4" };
    }),
    tampered((d) => {
      scenarioAt(d)["clips"] = {};
    }),
    tampered((d) => {
      (d["environments"] as Record<string, unknown>[])[0]!["scenarioIds"] = [];
    }),
    tampered((d) => {
      (d["environments"] as unknown[]).splice(0, 1);
    }),
    tampered((d) => {
      d["exportedUtc"] = "not-a-date";
    }),
    tampered((d) => {
      d["plan"] = { envCount: 1, perEnv: 1 };
    }),
  ];
  check(
    "reader rejects tampered indexes (schema, shape, seeds, xrefs, paths, counts)",
    results.every((r) => r === "caught"),
    `${results.filter((r) => r === "caught").length}/${results.length} caught`,
  );
  const located = JSON.parse(readerJson) as Record<string, unknown>;
  scenarioAt(located)["seed"] = "zero";
  const problems = validateCorpusIndex(JSON.stringify(located)).problems;
  check(
    "validation problems carry located paths",
    problems.length >= 1 && problems.some((p) => p.at === "scenarios[0].seed"),
    problems.map((p) => p.at).join(", "),
  );
}
{
  // Node adapter: write the corpus to a real temp dir (saveCorpus layout,
  // empty clip stand-ins) and consume it back through the reader.
  const { mkdtemp, writeFile, mkdir, rm, readFile } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "corpus-read-"));
  try {
    const writeJson = async (path: string, value: unknown): Promise<void> => {
      const full = join(dir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, corpusJson(value));
    };
    await writeJson(corpusIndexPath(777), readerIndex);
    for (const job of corpusPlan.jobs) {
      await writeJson(scenarioScriptPath(777, job.scenario.id), buildScenarioScriptDoc(job, 777));
      await writeJson(clipManifestPath(777, job.scenario.id), { standby: true });
      for (const camera of clipsByScenario[job.scenario.id] ?? []) {
        const full = join(dir, clipPath(777, job.scenario.id, camera));
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, "clip-bytes");
      }
    }
    const seenEnvs = new Set<string>();
    for (const job of corpusPlan.jobs) {
      if (seenEnvs.has(job.env.id)) continue;
      seenEnvs.add(job.env.id);
      await writeJson(envSpecPath(777, job.env.id), job.env);
    }
    const nodeFs: CorpusFilesystem = {
      readFile: async (p) => await readFile(join(dir, p), "utf8"),
    };
    const diskValidation = await readCorpusIndex(nodeFs, corpusIndexPath(777));
    const diskTuples = diskValidation.index ? [...iterTrainingTuples(diskValidation.index)] : [];
    const diskScriptOk =
      diskTuples[0] !== undefined &&
      (await readScenarioScript(nodeFs, diskTuples[0])).provenance.rootSeed === 777;
    check(
      "reader consumes a corpus written to real disk",
      diskValidation.ok && diskTuples.length === corpusPlan.jobs.length && diskScriptOk,
      `${diskTuples.length} tuples from temp export`,
    );
    {
      // A cross-planted or tampered script file must be caught by the
      // provenance check inside readScenarioScript (review hardening).
      const tuple0 = readerTuples[0]!;
      const forged = JSON.parse(memFiles.get(tuple0.scriptPath)!) as Record<string, unknown>;
      (forged["provenance"] as Record<string, unknown>)["seed"] = 1;
      const forgedFs: CorpusFilesystem = {
        readFile: async (p) =>
          p === tuple0.scriptPath ? JSON.stringify(forged) : memFiles.get(p)!,
      };
      let threw = false;
      try {
        await readScenarioScript(forgedFs, tuple0);
      } catch (e) {
        threw = String(e).includes("provenance mismatch") && String(e).includes("seed 1 !=");
      }
      check(
        "readScenarioScript rejects a script whose provenance contradicts the tuple",
        threw,
        "cross-planted script file rejected",
      );
    }
    {
      // Iterating a hand-built doc with a broken env xref must throw, not
      // silently drop tuples (review hardening).
      const broken = JSON.parse(readerJson) as Record<string, unknown>;
      (broken["scenarios"] as Record<string, unknown>[])[0]!["envId"] = "env-nope";
      let threw = false;
      try {
        for (const t of iterTrainingTuples(
          broken as unknown as Parameters<typeof iterTrainingTuples>[0],
        )) {
          void t;
        }
      } catch (e) {
        threw = String(e).includes('unknown environment "env-nope"');
      }
      check(
        "iterTrainingTuples throws on an unknown env instead of dropping tuples",
        threw,
        "contract is self-enforcing",
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Corpus JSON Schema (issue #9 schema milestone): the reusable schema at
// schemas/journeyman-corpus-index.v1.json is emitted from the exported
// corpusIndexJsonSchema const, and a mini JSON-Schema evaluator keeps the
// schema and the reader's structural walker from drifting apart: an explicit
// matrix of which layer catches which violation, plus fixture batteries on
// both sides.
// ---------------------------------------------------------------------------
type SchemaNode = Record<string, unknown>;
function schemaViolations(
  schema: SchemaNode,
  value: unknown,
  at: string,
  out: string[],
  rootDefs?: Record<string, SchemaNode>,
): void {
  const defs = rootDefs ?? ((schema["$defs"] ?? {}) as Record<string, SchemaNode>);
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    const resolved = ref.startsWith("#/$defs/") ? defs[ref.slice("#/$defs/".length)] : undefined;
    if (!resolved) {
      out.push(`${at}: unresolved $ref ${ref}`);
      return;
    }
    schemaViolations(resolved, value, at, out, defs);
    return;
  }
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema["const"])) {
    out.push(`${at}: const mismatch`);
    return;
  }
  if ("enum" in schema) {
    const allowed = schema["enum"] as unknown[];
    if (!allowed.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
      out.push(`${at}: enum mismatch`);
    }
  }
  const type = schema["type"] as string | undefined;
  if (typeof type === "string") {
    const matches =
      (type === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) ||
      (type === "array" && Array.isArray(value)) ||
      (type === "string" && typeof value === "string") ||
      (type === "integer" && typeof value === "number" && Number.isInteger(value)) ||
      (type === "number" && typeof value === "number");
    if (!matches) {
      out.push(`${at}: expected ${type}`);
      return;
    }
  }
  if (typeof value === "string") {
    const minLen = schema["minLength"];
    if (typeof minLen === "number" && value.length < minLen) out.push(`${at}: minLength`);
    const pattern = schema["pattern"];
    if (typeof pattern === "string" && !new RegExp(pattern).test(value)) out.push(`${at}: pattern`);
    // "format": "date-time" is intentionally annotation-only here (RFC 9457
    // makes format non-assertive without a vocab); the reader enforces it.
  }
  if (typeof value === "number") {
    const min = schema["minimum"];
    if (typeof min === "number" && value < min) out.push(`${at}: minimum`);
  }
  if (Array.isArray(value)) {
    const minItems = schema["minItems"];
    if (typeof minItems === "number" && value.length < minItems) out.push(`${at}: minItems`);
    const items = schema["items"];
    if (items && typeof items === "object") {
      value.forEach((v, i) => schemaViolations(items as SchemaNode, v, `${at}[${i}]`, out, defs));
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of (schema["required"] as string[] | undefined) ?? []) {
      if (!(key in record)) out.push(`${at}.${key}: required`);
    }
    const minProps = schema["minProperties"];
    if (typeof minProps === "number" && Object.keys(record).length < minProps) {
      out.push(`${at}: minProperties`);
    }
    const props = (schema["properties"] ?? {}) as Record<string, SchemaNode>;
    const additional = schema["additionalProperties"];
    for (const [key, v] of Object.entries(record)) {
      if (key in props) schemaViolations(props[key]!, v, `${at}.${key}`, out, defs);
      else if (additional === false) out.push(`${at}.${key}: additionalProperties`);
      else if (additional && typeof additional === "object") {
        schemaViolations(additional as SchemaNode, v, `${at}.${key}`, out, defs);
      }
    }
  }
}
const schemaCheck = (doc: unknown): string[] => {
  const out: string[] = [];
  schemaViolations(factoryApi.corpusIndexJsonSchema as unknown as SchemaNode, doc, "$", out);
  return out;
};

// The checked-in schema file is generated from the const — never hand-edited.
{
  const { readFile } = await import("node:fs/promises");
  // Normalize CRLF: the artifact is pinned to LF via .gitattributes, but a
  // checkout made before that pin may still have CRLF on disk.
  const onDisk = (await readFile("schemas/journeyman-corpus-index.v1.json", "utf8")).replace(
    /\r\n/g,
    "\n",
  );
  check(
    "schemas/*.json is fresh (emitted from corpusIndexJsonSchema)",
    onDisk === corpusJson(factoryApi.corpusIndexJsonSchema),
    "byte-identical to the exported const",
  );
}
check(
  "schema accepts a freshly built index",
  schemaCheck(JSON.parse(readerJson)).length === 0,
  `${readerIndex.scenarios.length}-scenario index validates clean`,
);
{
  // Reader-accepted variations must stay schema-accepted (no overfitting to
  // one corpus shape): a second base corpus plus tolerated mutations.
  const plan2 = planFactory(42, { envCount: 2, perEnv: 1 });
  const variedCameras: Record<string, string[]> = {};
  plan2.jobs.forEach((job, i) => {
    variedCameras[job.scenario.id] = i === 0 ? ["front", "wrist"] : ["head"];
  });
  const varied = JSON.parse(
    corpusJson(
      buildCorpusIndex({
        plan: plan2,
        clipsByScenario: variedCameras,
        exportedUtc: "2026-01-02T03:04:05.000Z",
      }),
    ),
  ) as Record<string, unknown>;
  const env0 = (varied["environments"] as Record<string, unknown>[])[0]!;
  env0["machineRotation"] = 2.7;
  env0["palette"] = "midnight-shop";
  env0["variant"] = "graveyard-crew";
  varied["engineVersion"] = "0.0.1-test";
  const scen0 = (varied["scenarios"] as Record<string, unknown>[])[0]!;
  scen0["templateId"] = "custom-mode";
  (scen0["lesson"] as Record<string, unknown>)["title"] = "Custom lesson";
  check(
    "schema + reader agree on tolerated variations (shape, extra cameras, labels)",
    schemaCheck(varied).length === 0 && validateCorpusIndex(JSON.stringify(varied)).ok,
    `varied corpus accepted by both`,
  );
}
{
  // Violations within the schema's declared scope must be rejected.
  const bad = (mutate: (doc: Record<string, unknown>) => void): unknown => {
    const clone = JSON.parse(readerJson) as Record<string, unknown>;
    mutate(clone);
    return clone;
  };
  const scen0 = (d: Record<string, unknown>): Record<string, unknown> =>
    (d["scenarios"] as Record<string, unknown>[])[0]!;
  const env0 = (d: Record<string, unknown>): Record<string, unknown> =>
    (d["environments"] as Record<string, unknown>[])[0]!;
  const cases: Array<[string, Record<string, unknown>]> = [
    ["wrong schema const", bad((d) => (d["schema"] = "nope"))],
    ["wrong schemaVersion", bad((d) => (d["schemaVersion"] = 2))],
    ["negative rootSeed", bad((d) => (d["rootSeed"] = -1))],
    ["fractional rootSeed", bad((d) => (d["rootSeed"] = 777.5))],
    ["empty engineVersion", bad((d) => (d["engineVersion"] = ""))],
    ["plan.perEnv 0", bad((d) => (d["plan"] = { envCount: 1, perEnv: 0 }))],
    ["plan missing count", bad((d) => delete (d["plan"] as Record<string, unknown>)["envCount"])],
    ["env missing required", bad((d) => delete env0(d)["variant"])],
    ["env atcSide not ±1", bad((d) => (env0(d)["atcSide"] = 2))],
    ["env seed 0", bad((d) => (env0(d)["seed"] = 0))],
    ["spec wrong subtree", bad((d) => (env0(d)["spec"] = "corpora/0000000777/envx/env-00.json"))],
    [
      "backslash spec",
      bad((d) => (env0(d)["spec"] = "corpora\\\\0000000777\\\\envs\\\\env-00.json")),
    ],
    ["scenario missing lesson", bad((d) => delete scen0(d)["lesson"])],
    [
      "lesson title empty",
      bad((d) => ((scen0(d)["lesson"] as Record<string, unknown>)["title"] = "")),
    ],
    ["scenario seed fractional", bad((d) => (scen0(d)["seed"] = 1.5))],
    ["clips empty", bad((d) => (scen0(d)["clips"] = {}))],
    [
      "clip wrong directory",
      bad(
        (d) =>
          (scen0(d)["clips"] = { front: "corpora/0000000777/other/sensor-trip-env-00/front.mp4" }),
      ),
    ],
    [
      "manifest wrong name",
      bad(
        (d) => (scen0(d)["manifest"] = "corpora/0000000777/clips/sensor-trip-env-00/manifold.json"),
      ),
    ],
    [
      "script dot-dot escape",
      bad((d) => (scen0(d)["script"] = "corpora/0000000777/scenarios/../env-00.json")),
    ],
    ["additional top-level prop", bad((d) => (d["extra"] = 1))],
    ["scenarios empty array", bad((d) => (d["scenarios"] = []))],
  ];
  const missed = cases.filter(([, doc]) => schemaCheck(doc).length === 0).map(([name]) => name);
  check(
    "schema rejects fixture violations within its scope",
    missed.length === 0,
    missed.length === 0
      ? `${cases.length}/${cases.length} rejected`
      : `MISSED: ${missed.join("; ")}`,
  );
}
{
  // Drift matrix: for each reader-battery mutation, exactly one layer is the
  // catcher. Cross-reference/count/format rules are the reader's (the schema
  // is per-item and intentionally tolerates them); everything else the
  // schema catches too. If either implementation changes, this breaks and
  // the matrix + the Zod derivation note must be revisited.
  const matrix: Array<[string, boolean, boolean]> = [];
  const mutateDoc = (mutate: (doc: Record<string, unknown>) => void): string => {
    const clone = JSON.parse(readerJson) as Record<string, unknown>;
    mutate(clone);
    return JSON.stringify(clone);
  };
  const scen0 = (d: Record<string, unknown>): Record<string, unknown> =>
    (d["scenarios"] as Record<string, unknown>[])[0]!;
  // Expected catchers: (reader, schema). Per-item rules (consts, integer/
  // minimum seeds, subtree patterns, minProperties) are caught by BOTH;
  // document-level rules (counts, cross-refs, per-env order, date format,
  // clip-subtree coherence) are the reader's alone — the schema is per-item
  // and RFC-tolerant on format.
  const R = true;
  const S = false;
  const mutations: Array<[string, (d: Record<string, unknown>) => void, boolean, boolean]> = [
    ["wrong schema", (d) => (d["schema"] = "nope"), R, !S],
    ["wrong version", (d) => (d["schemaVersion"] = 2), R, !S],
    ["dropped scenario", (d) => (d["scenarios"] as unknown[]).splice(0, 1), R, S],
    ["negative seed", (d) => (scen0(d)["seed"] = -1), R, !S],
    ["unknown env xref", (d) => (scen0(d)["envId"] = "env-nope"), R, S],
    [
      "dot-dot script",
      (d) => (scen0(d)["script"] = "corpora/0000000777/scenarios/../x.json"),
      R,
      !S,
    ],
    ["wrong manifest", (d) => (scen0(d)["manifest"] = "renders/x.json"), R, !S],
    [
      "wrong clip dir",
      (d) => (scen0(d)["clips"] = { front: "corpora/0000000777/clips/wrong/front.mp4" }),
      R,
      S,
    ],
    ["empty clips", (d) => (scen0(d)["clips"] = {}), R, !S],
    [
      "empty env scenarioIds",
      (d) => ((d["environments"] as Record<string, unknown>[])[0]!["scenarioIds"] = []),
      R,
      S,
    ],
    ["dropped environment", (d) => (d["environments"] as unknown[]).splice(0, 1), R, S],
    ["bad exportedUtc", (d) => (d["exportedUtc"] = "not-a-date"), R, S],
    ["count-mismatch plan", (d) => (d["plan"] = { envCount: 1, perEnv: 1 }), R, S],
  ];
  for (const [name, mutate, readerRejects, schemaRejects] of mutations) {
    const json = mutateDoc(mutate);
    const readerRejectsActual = !validateCorpusIndex(json).ok;
    const schemaRejectsActual = schemaCheck(JSON.parse(json)).length > 0;
    matrix.push([
      name,
      readerRejectsActual === readerRejects && schemaRejectsActual === schemaRejects,
      readerRejectsActual,
      schemaRejectsActual,
    ]);
  }
  const drifted = matrix.filter(([, ok]) => !ok).map(([name]) => name);
  check(
    "reader/schema drift matrix holds (13 mutations, expected catcher per layer)",
    drifted.length === 0,
    drifted.length === 0
      ? matrix
          .map(
            ([name, , r, s]) =>
              `${name}:${r ? "reader" : ""}${r && s ? "+" : ""}${s ? "schema" : ""}`,
          )
          .join(", ")
      : `DRIFTED: ${drifted.join("; ")}`,
  );
}

console.log(`\n${failures === 0 ? "ALL FACTORY CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
