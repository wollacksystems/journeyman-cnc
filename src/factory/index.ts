/**
 * Public API of the journeyman-sim factory (issue #9): a declarative
 * TypeScript package for generating seeded simulation footage corpora.
 *
 * A {@link Simulation} is a pure, seed-complete program: the same spec
 * yields the identical corpus on every machine, which is the contract the
 * ingest pipeline depends on.
 *
 * Quickstart:
 *
 * ```ts
 * import { createSimulation } from "./factory/index.ts";
 *
 * const sim = createSimulation({ seed: 2026, shape: { envCount: 4, perEnv: 3 } });
 * const described = sim.describe();             // what will this seed produce?
 * const plan = sim.plan();                      // pure data, headless-safe
 * const out = await sim.render(world);          // footage (browser)
 * const saved = await sim.export(plan, out.results); // stable on-disk corpus
 * ```
 *
 * Layer map (who may depend on what):
 * - **public (this module)**: the simulation handle, plan data, env/spec
 *   types, corpus artifacts, and the template-extension surface.
 * - **internal**: `world.ts`, `render.ts`, `corpus-save.ts`, `rng.ts`, and
 *   the browser-only capture pipeline — reachable only through the handle's
 *   effectful methods (`render`, `export`, `renderAndExport`), which load
 *   their engine modules lazily so pure stages never import WebGL.
 *
 * Every export here carries TSDoc and is part of the semver contract; if
 * it lives in an internal module and is not re-exported here, it is not
 * public API.
 */
export { createSimulation } from "./simulation";
export type {
  Simulation,
  SimulationSpec,
  SimulationSummary,
  SimulationRenderResult,
  SimulationRenderOptions,
} from "./simulation";

// Declaration layer: seed-complete plan data (pure, headless-safe).
export { planFactory, DEFAULT_FACTORY_OPTIONS } from "./plan";
export type { FactoryJob, FactoryOptions, FactoryPlan, TemplateId } from "./plan";

// Environment layer: what a generated world is (spec + provenance).
export type { EnvSpec, EnvPalette } from "./environment";
export { ENV_PALETTES, LOCKED_ENV, generateEnvironment } from "./environment";

// Template layer: the extensible failure-mode registry.
export { TEMPLATE_IDS, TEMPLATE_REGISTRY, generateScenario, scenarioSeedFor } from "./scenario-gen";
export type { FactoryScenario } from "./scenario-gen";

// Corpus artifacts: the stable on-disk contract with ingest.
export {
  buildCorpusIndex,
  buildScenarioScriptDoc,
  corpusDirName,
  corpusIndexPath,
  corpusJson,
  corpusRootPath,
  clipManifestPath,
  clipPath,
  envSpecPath,
  scenarioScriptPath,
} from "./corpus";
export type {
  CorpusIndex,
  CorpusIndexEnvironment,
  CorpusIndexScenario,
  ScenarioScriptDoc,
} from "./corpus";
export type { FactoryCaptureManifest } from "./manifest";
export type { CorpusExportSummary } from "./corpus-save";

// Execution types (the values are internal; see the layer map above).
export type { FactoryCaptureResult, FactoryRenderOptions } from "./render";
export type { FactoryWorld, FactoryWorldOptions } from "./world";
export type { Rng } from "./rng";
export { createRng, hashSeed } from "./rng";
