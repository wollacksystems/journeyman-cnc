/**
 * Headless deterministic proof for the factory layer: seeded planning,
 * generated scenario validity, provenance manifests, and the environment
 * binding that lets templates run in any generated environment.
 */
import { planFactory } from "../src/factory/plan.ts";
import { generateScenario } from "../src/factory/scenario-gen.ts";
import { generateEnvironment, LOCKED_ENV, toWorld } from "../src/factory/environment.ts";
import { buildFactoryManifest } from "../src/factory/manifest.ts";
import { createRng } from "../src/factory/rng.ts";
import { createMachineCell } from "../src/cell.ts";
import { CameraRig } from "../src/rig.ts";
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

// 4. Environment binding: world-space anchors equal the machine-frame mapping.
let bindingHolds = true;
for (const job of planA.jobs) {
  const expected = toWorld(job.env, [0.42, 1.02, 0.4]); // guard sensor face anchor
  const got = job.scenario.faultWorld;
  if (expected.some((v, i) => Math.abs(v - got[i]) > 1e-9)) bindingHolds = false;
}
check(
  "fault anchor equals toWorld(machine frame)",
  bindingHolds,
  "faultWorld == toWorld(env, [0.42, 1.02, 0.4]) for all jobs",
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

console.log(`\n${failures === 0 ? "ALL FACTORY CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
