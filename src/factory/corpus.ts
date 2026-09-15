import { ENGINE_VERSION } from "../version";
import type { EnvSpec } from "./environment";
import type { FactoryJob } from "./plan";
import { scenarioSeedFor, type FactoryScenario } from "./scenario-gen";

/**
 * Stable on-disk corpus layout (all paths relative to the corpus root):
 *
 *   corpora/<rootSeedPadded10>/        corpus root (padded so lexical order
 *                                      equals numeric seed order)
 *     index.json                       CorpusIndex: the ingest entry point
 *     envs/<env-id>.json               full EnvSpec (geometry provenance)
 *     scenarios/<scenario-id>.json     generated script + provenance (ground
 *                                      truth for ingest: beats, narration,
 *                                      lesson, cell timeline)
 *     clips/<scenario-id>/<camera>.mp4 per-camera footage
 *     clips/<scenario-id>/manifest.json capture manifest (intrinsics,
 *                                      timeline, factory provenance)
 *
 * Stability contract: paths are a pure function of (root seed, env id,
 * scenario id, camera). Re-exporting a corpus with the same root seed
 * overwrites in place and yields byte-identical JSON — no timestamps in any
 * path — so ingest can key on paths as stable recall identities.
 */

/** Zero-padded 10-digit root seed used as the corpus directory name. */
export function corpusDirName(rootSeed: number): string {
  return rootSeed.toString().padStart(10, "0");
}

/** Slash-separated paths relative to the project root, POSIX-style. */
export type RelPath = string;

export function corpusRootPath(rootSeed: number): RelPath {
  return `corpora/${corpusDirName(rootSeed)}`;
}

export function corpusIndexPath(rootSeed: number): RelPath {
  return `${corpusRootPath(rootSeed)}/index.json`;
}

export function envSpecPath(rootSeed: number, envId: string): RelPath {
  return `${corpusRootPath(rootSeed)}/envs/${envId}.json`;
}

export function scenarioScriptPath(rootSeed: number, scenarioId: string): RelPath {
  return `${corpusRootPath(rootSeed)}/scenarios/${scenarioId}.json`;
}

export function clipPath(rootSeed: number, scenarioId: string, camera: string): RelPath {
  return `${corpusRootPath(rootSeed)}/clips/${scenarioId}/${camera}.mp4`;
}

export function clipManifestPath(rootSeed: number, scenarioId: string): RelPath {
  return `${corpusRootPath(rootSeed)}/clips/${scenarioId}/manifest.json`;
}

/** One exported scenario entry in the index: script, clips, and lesson. */
export interface CorpusIndexScenario {
  scenarioId: string;
  /** Template the scenario was generated from. */
  templateId: string;
  /** Environment the scenario runs in (see `environments`). */
  envId: string;
  /** Per-scenario sub-seed; regenerating from it reproduces the script. */
  seed: number;
  /** Lesson carried into ingest as ground-truth labels. */
  lesson: { title: string; body: string };
  /** Script (ground truth) relative path. */
  script: RelPath;
  /** Capture manifest relative path. */
  manifest: RelPath;
  /** Per-camera clip relative paths. */
  clips: Record<string, RelPath>;
}

/** One exported environment entry in the index. */
export interface CorpusIndexEnvironment {
  envId: string;
  /** Environment generation seed. */
  seed: number;
  /** Flavor label (shift/crew) baked into manifests. */
  variant: string;
  machineRotation: number;
  atcSide: 1 | -1;
  palette: string;
  /** Full EnvSpec relative path. */
  spec: RelPath;
  /** Scenario ids generated in this environment, in plan order. */
  scenarioIds: string[];
}

/**
 * The ingest entry point committed as `index.json` at every corpus root.
 * Everything downstream needs (grouping, recall keys, replay) is reachable
 * from this document without opening the per-artifact JSON.
 */
export interface CorpusIndex {
  schema: "journeyman-corpus-index";
  schemaVersion: 1;
  /** Root seed of the factory run that produced this corpus. */
  rootSeed: number;
  engineVersion: string;
  /** Planning options the corpus was generated with. */
  plan: { envCount: number; perEnv: number };
  /** UTC instant the corpus was exported (NOT part of any path). */
  exportedUtc: string;
  /** Environment entries in plan order. */
  environments: CorpusIndexEnvironment[];
  /** Scenario entries in plan order (the render order). */
  scenarios: CorpusIndexScenario[];
}

/** Shape of one generated scenario serialized for the ingest pipeline. */
export interface ScenarioScriptDoc extends FactoryScenario {
  provenance: {
    /** Root seed of the corpus run (self-contained traceability). */
    rootSeed: number;
    envId: string;
    envSeed: number;
    /** Per-scenario sub-seed (equals `seed` in the index entry). */
    seed: number;
    templateId: string;
    slot: number;
    engineVersion: string;
  };
}

/** Build the serializable script document for one job. */
export function buildScenarioScriptDoc(job: FactoryJob, rootSeed: number): ScenarioScriptDoc {
  const scenario = job.scenario;
  return {
    ...scenario,
    provenance: {
      rootSeed,
      envId: job.env.id,
      envSeed: job.env.seed,
      seed: scenarioSeedFor(job.env, scenario.templateId, scenario.slot),
      templateId: scenario.templateId,
      slot: scenario.slot,
      engineVersion: ENGINE_VERSION,
    },
  };
}

/**
 * Assemble the corpus index from a plan and its capture results. Clip maps
 * mirror `result.clips` per scenario; paths are computed, never stored from
 * browser download names, so the index is identical across export channels.
 */
export function buildCorpusIndex(args: {
  plan: {
    rootSeed: number;
    envCount: number;
    perEnv: number;
    jobs: FactoryJob[];
  };
  /** Per-scenario camera lists as rendered (drives the clip path map). */
  clipsByScenario: Record<string, string[]>;
  exportedUtc: string;
}): CorpusIndex {
  const { plan, clipsByScenario, exportedUtc } = args;
  const rootSeed = plan.rootSeed;

  const environments: CorpusIndexEnvironment[] = [];
  const scenarios: CorpusIndexScenario[] = [];
  const byEnv = new Map<string, CorpusIndexEnvironment>();

  for (const job of plan.jobs) {
    const env: EnvSpec = job.env;
    let entry = byEnv.get(env.id);
    if (!entry) {
      entry = {
        envId: env.id,
        seed: env.seed,
        variant: env.variant,
        machineRotation: env.machineRotation,
        atcSide: env.atcSide,
        palette: env.palette.name,
        spec: envSpecPath(rootSeed, env.id),
        scenarioIds: [],
      };
      byEnv.set(env.id, entry);
      environments.push(entry);
    }
    entry.scenarioIds.push(job.scenario.id);

    const clips: Record<string, RelPath> = {};
    for (const camera of clipsByScenario[job.scenario.id] ?? []) {
      clips[camera] = clipPath(rootSeed, job.scenario.id, camera);
    }
    scenarios.push({
      scenarioId: job.scenario.id,
      templateId: job.scenario.templateId,
      envId: env.id,
      seed: scenarioSeedFor(env, job.scenario.templateId, job.scenario.slot),
      lesson: { title: job.scenario.lesson.title, body: job.scenario.lesson.body },
      script: scenarioScriptPath(rootSeed, job.scenario.id),
      manifest: clipManifestPath(rootSeed, job.scenario.id),
      clips,
    });
  }

  return {
    schema: "journeyman-corpus-index",
    schemaVersion: 1,
    rootSeed,
    engineVersion: ENGINE_VERSION,
    plan: { envCount: plan.envCount, perEnv: plan.perEnv },
    exportedUtc,
    environments,
    scenarios,
  };
}

/** JSON serialization used for every corpus document (stable + pretty). */
export function corpusJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
