/**
 * The factory's public package API (issue #9): `createSimulation` turns one
 * declarative spec into a {@link Simulation} handle whose layered methods
 * derive every artifact from the seed alone.
 *
 * This module is a facade — no engine logic lives here. Determinism flows
 * through the proven layers beneath it (`planFactory` -> `renderFactoryJob`
 * -> `saveCorpus`), each of which is already seed-complete and contract
 * tested by verify:factory.
 *
 * Layer boundary (who may depend on what):
 *  - public: everything exported from `./index.ts` (this handle, plan data,
 *    env/spec types, corpus artifacts, template-extension types)
 *  - internal: `./world.ts`, `./render.ts`, `./corpus-save.ts`, `./rng.ts`
 *    and the browser-only capture pipeline — reachable only through the
 *    handle's effectful methods (loaded lazily so pure stages never pull in
 *    the WebGL/encoding stack)
 */

import type { EnvSpec } from "./environment";
import type { FactoryJob, FactoryPlan } from "./plan";
import { planFactory } from "./plan";
import type { CorpusExportSummary } from "./corpus-save";
import type { FactoryCaptureResult, FactoryRenderOptions } from "./render";
import type { FactoryWorld } from "./world";

/**
 * A fully declarative description of a generated corpus. JSON-serializable
 * by contract: a checked-in spec replays to the identical corpus on any
 * machine, which is the property ingest relies on.
 */
export interface SimulationSpec {
  /**
   * Root seed. The seed fully determines the corpus: environment geometry,
   * palettes, scenario scripts, narration picks, and beat timings.
   */
  seed: number;
  /** Corpus shape: how many environments and scenarios per environment. */
  shape: {
    /** Distinct generated environments (minimum 1). */
    envCount: number;
    /** Scenarios per environment; failure modes cycle by slot. */
    perEnv: number;
  };
}

/**
 * What a seed will produce, without executing anything. Pure data — safe to
 * log, diff, or hash before committing to a render.
 */
export interface SimulationSummary {
  seed: number;
  envCount: number;
  scenarioCount: number;
  /** One row per generated environment, in plan order. */
  environments: Array<{
    id: string;
    variant: string;
    palette: string;
    /** Cell yaw in degrees (whole-room orientation). */
    rotationDeg: number;
    atcSide: 1 | -1;
    scenarios: Array<{ id: string; templateId: string; slot: number; lesson: string }>;
  }>;
}

/** Result of rendering the full plan: one capture result per job. */
export interface SimulationRenderResult {
  /** Capture outputs in plan order (clips + provenance manifest per job). */
  results: FactoryCaptureResult[];
  clipCount: number;
}

/** Render options at the facade level: like {@link FactoryRenderOptions}, but
 * progress reports also name the job it belongs to. Progress payload is
 * structural so pure consumers never import the capture stack. */
export type SimulationRenderOptions = Omit<FactoryRenderOptions, "onProgress"> & {
  onProgress?: (
    p: {
      camera: string;
      frame: number;
      totalFrames: number;
      cameraIndex: number;
      cameraTotal: number;
    },
    job: FactoryJob,
  ) => void;
};

/**
 * The layered handle returned by {@link createSimulation}. Each method is a
 * pure derivation of the previous stage — except {@link Simulation.render},
 * {@link Simulation.export}, and {@link Simulation.renderAndExport}, which
 * are the explicit effectful boundary.
 */
export interface Simulation {
  /** The normalized spec this handle was created from. */
  readonly spec: SimulationSpec;

  /** What would this seed produce? No WebGL, no rendering, no downloads. */
  describe(): SimulationSummary;

  /** Derive the deterministic execution plan (pure data; headless-safe). */
  plan(): FactoryPlan;

  /**
   * Apply the planned job at `index` (mod job count) to a live factory
   * world — the dev-preview affordance: step through generated environments
   * on the visible canvas without rendering. Returns a disposer that
   * restores the environment the world had before this call.
   */
  preview(
    world: FactoryWorld,
    index: number,
    options?: { onJob?: (job: FactoryJob, index: number) => void },
  ): () => void;

  /**
   * Render the full plan through the shared factory world (the effectful
   * boundary — one clip per camera per job, deterministic frame timing).
   */
  render(world: FactoryWorld, options?: SimulationRenderOptions): Promise<SimulationRenderResult>;

  /**
   * Save a rendered plan at the stable corpus layout and return the export
   * summary. The index downloads last, so `index.json` on disk certifies
   * the corpus is complete.
   */
  export(plan: FactoryPlan, results: FactoryCaptureResult[]): Promise<CorpusExportSummary>;

  /** Convenience composition of {@link Simulation.render} + {@link Simulation.export}. */
  renderAndExport(
    world: FactoryWorld,
    options?: SimulationRenderOptions,
  ): Promise<CorpusExportSummary>;
}

function normalizeSpec(spec: SimulationSpec): SimulationSpec {
  const envCount = Math.max(1, Math.floor(spec.shape.envCount) || 1);
  const perEnv = Math.max(1, Math.floor(spec.shape.perEnv) || 1);
  return { seed: spec.seed >>> 0, shape: { envCount, perEnv } };
}

function summarize(plan: FactoryPlan): SimulationSummary {
  const byEnv = new Map<string, SimulationSummary["environments"][number]>();
  for (const job of plan.jobs) {
    const env = job.env;
    let row = byEnv.get(env.id);
    if (!row) {
      row = {
        id: env.id,
        variant: env.variant,
        palette: env.palette.name,
        rotationDeg: Math.round((env.machineRotation * 180) / Math.PI),
        atcSide: env.atcSide,
        scenarios: [],
      };
      byEnv.set(env.id, row);
    }
    row.scenarios.push({
      id: job.scenario.id,
      templateId: job.scenario.templateId,
      slot: job.scenario.slot,
      lesson: job.scenario.lesson.title,
    });
  }
  return {
    seed: plan.rootSeed,
    envCount: plan.envCount,
    scenarioCount: plan.jobs.length,
    environments: [...byEnv.values()],
  };
}

/** Render every job of `plan` in order, threading the corpus root seed. */
async function renderAll(
  world: FactoryWorld,
  plan: FactoryPlan,
  options?: SimulationRenderOptions,
): Promise<FactoryCaptureResult[]> {
  const { renderFactoryJob } = await import("./render");
  const results: FactoryCaptureResult[] = [];
  const { onProgress, ...rest } = options ?? {};
  for (const job of plan.jobs) {
    // Root seed comes from the plan, not the caller: provenance must name
    // the corpus the job belongs to even for ad-hoc single-job renders.
    const jobOptions: FactoryRenderOptions = { ...rest, rootSeed: plan.rootSeed };
    if (onProgress) jobOptions.onProgress = (p) => onProgress(p, job);
    results.push(await renderFactoryJob(world, job, jobOptions));
  }
  return results;
}

/**
 * Create a {@link Simulation} from a declarative spec. Pure — nothing is
 * generated until a handle method runs; the same spec always yields the
 * same corpus.
 *
 * ```ts
 * const sim = createSimulation({ seed: 2026, shape: { envCount: 4, perEnv: 3 } });
 * console.log(sim.describe());
 * const plan = sim.plan();             // pure data
 * const out = await sim.render(world); // footage
 * await sim.export(plan, out.results); // stable on-disk corpus
 * ```
 */
export function createSimulation(spec: SimulationSpec): Simulation {
  const normalized = normalizeSpec(spec);

  const plan = (): FactoryPlan =>
    planFactory(normalized.seed, {
      envCount: normalized.shape.envCount,
      perEnv: normalized.shape.perEnv,
    });

  return {
    spec: normalized,

    describe(): SimulationSummary {
      return summarize(plan());
    },

    plan,

    preview(world, index, options) {
      const jobs = plan().jobs;
      const job = jobs[((index % jobs.length) + jobs.length) % jobs.length];
      if (!job) throw new Error("factory plan has no jobs");
      const previousEnv: EnvSpec = world.env;
      world.setEnv(job.env);
      options?.onJob?.(job, index);
      return () => {
        world.setEnv(previousEnv);
      };
    },

    async render(world, options): Promise<SimulationRenderResult> {
      const results = await renderAll(world, plan(), options);
      return {
        results,
        clipCount: results.reduce((n, r) => n + r.clips.length, 0),
      };
    },

    async export(p, results): Promise<CorpusExportSummary> {
      const { saveCorpus } = await import("./corpus-save");
      return saveCorpus(p, results);
    },

    async renderAndExport(world, options): Promise<CorpusExportSummary> {
      const p = plan();
      const results = await renderAll(world, p, options);
      const { saveCorpus } = await import("./corpus-save");
      return saveCorpus(p, results);
    },
  };
}
