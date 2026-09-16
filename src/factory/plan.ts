import { createRng, type Rng } from "./rng";
import { generateEnvironment, type EnvSpec } from "./environment";
import { generateScenario, TEMPLATE_IDS, type FactoryScenario } from "./scenario-gen";

/**
 * Factory corpus planner.
 *
 * A single root seed fans out deterministically: one seeded environment per
 * slot, then one generated scenario per (environment, template) pair using a
 * per-scenario sub-seed derived from the environment's own RNG stream. Two
 * factory runs with the same root seed yield identical specs end to end.
 *
 * @module
 * @example
 * ```ts
 * import { planFactory, TEMPLATE_IDS } from "@/factory/plan.ts";
 *
 * const plan = planFactory(2026, { envCount: 2, perEnv: 3 });
 * plan.jobs.length; // 6 — one job per (environment, template) pair
 * for (const job of plan.jobs) {
 *   console.log(job.env.id, job.scenario.templateId, job.scenario.id);
 * }
 * ```
 */
// Template ids are owned by the scenario generator (single source of truth).
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export interface FactoryOptions {
  /** Number of distinct generated environments. */
  envCount: number;
  /** Scenarios per environment (templates cycled by index). */
  perEnv: number;
}

export const DEFAULT_FACTORY_OPTIONS: FactoryOptions = {
  envCount: 2,
  perEnv: 1,
};

export interface FactoryJob {
  env: EnvSpec;
  scenario: FactoryScenario;
}

export interface FactoryPlan {
  rootSeed: number;
  envCount: number;
  perEnv: number;
  jobs: FactoryJob[];
}

/**
 * Deterministically plan a factory run: seed -> environments -> scenarios.
 * Pure data — no DOM, no WebGL — so it is unit-testable headlessly.
 *
 * @param rootSeed - Root of the seed tree: every environment and scenario
 *   sub-seed derives from it, so the plan is identical for identical seeds.
 * @param options - Shape override; unset fields fall back to
 *   {@link DEFAULT_FACTORY_OPTIONS}.
 * @example
 * ```ts
 * const plan = planFactory(7, { envCount: 1, perEnv: 1 });
 * // plan.jobs[0].env.seed and plan.jobs[0].scenario.seed are now fixed:
 * // replanning with seed 7 reproduces both exactly.
 * ```
 */
export function planFactory(rootSeed: number, options?: Partial<FactoryOptions>): FactoryPlan {
  const opts = { ...DEFAULT_FACTORY_OPTIONS, ...options };
  const rng: Rng = createRng(rootSeed >>> 0);
  const jobs: FactoryJob[] = [];

  for (let ei = 0; ei < opts.envCount; ei++) {
    const envSeed = rng.int(1, 0x7fffffff);
    const env = generateEnvironment(envSeed, ei, createRng(envSeed));
    for (let si = 0; si < opts.perEnv; si++) {
      const templateId = TEMPLATE_IDS[si % TEMPLATE_IDS.length]!;
      // Slot = cycle index so repeated templates within an environment (perEnv
      // > TEMPLATE_IDS.length) still generate distinct, deterministic scenarios.
      const slot = Math.floor(si / TEMPLATE_IDS.length);
      const scenario: FactoryScenario = generateScenario(env, templateId, 50, slot);
      jobs.push({ env, scenario });
    }
  }

  return { rootSeed: rootSeed >>> 0, envCount: opts.envCount, perEnv: opts.perEnv, jobs };
}
