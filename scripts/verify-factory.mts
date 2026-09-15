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

console.log(`\n${failures === 0 ? "ALL FACTORY CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
