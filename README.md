# journeyman-sim

Synthetic CNC training environment for the Journeyman pipeline: a headless-capable
Three.js rig that renders scripted industrial scenarios, records them per camera,
and feeds the footage through the real ingest path (frames + embeddings +
transcripts + RAG) as ground-truth-labeled fixtures.

## Approach (locked)

- Plain Three.js + TypeScript + Vite. No physics engine.
- 1080p / 30 fps. Primitive-first geometry (boxes, cylinders, capsules).
- Three scripted scenarios (45-60 s each): false sensor trip, way-lube failure,
  ATC jam. Plain-text narration with TTS; the transcript is ground truth.
- Rendered composite proof view for deliverables; the live inspector window is
  dev-only.
- One WebGLRenderer, six scissored viewports: 2 static side cams, head + chest
  cams on a primitive avatar, 2 debug cams.
- Commit JSON manifests + small smoke fixtures to the repo; full-resolution
  renders stay in gitignored local `renders/`.

## Status

Phase 0 - repo bootstrap. Phase 1 - six-viewport scissored camera rig (merged).
Phase 2 - capture pipeline: deterministic scenario layer (types/drive, beats +
narration + cell timeline + lesson), a first scripted scenario (sensor-trip,
20 s smoke), per-camera MP4 batch rendering via mediabunny (WebCodecs
H.264/VP9/AV1 -> MP4, in-memory), a MediaRecorder composite webm, and a capture
manifest with camera intrinsics + beat timeline + transcript (ground truth for
ingest). Phase 3 - locked 50 s corpus: stretched sensor-trip plus way-lube and
ATC jam scenarios, a registry-driven selector and corpus batch render, visible
way-lube/ATC cell state, compact labeled fixtures, and headless scenario proof.

Batch outputs land in gitignored `renders/<scenario-id>/`; small fixtures are
committed. Feature work happens on the `synthetic-capture` branch (see
`worktrees/` conventions in the parent workspace).

Phase 4 - factory of sims (v0.2.0): the singleton simulator became a generator.
A seeded planner produces whole corpora of environments and scenario scripts as
data, rendered through the same deterministic capture pipeline with full
provenance manifests for recall (see "Factory of sims" below).

## Phase 2 capture flow (dev controls)

The dev toolbar (lower-left) exposes two captures:

- `REC COMPOSITE` - real-time `canvas.captureStream` + `MediaRecorder` webm of
  the 6-viewport composite, wall-clock loop reset to t=0.
- `RENDER CORPUS` - deterministic offline batch. For every registered production
  scenario, each production camera is driven frame-by-frame (frame N always =
  sim time N / fps) and encoded straight to MP4 by mediabunny's `CanvasSource`
  (keyframe every 1 s). Saves `renders/<scenario-id>/{side-a,side-b,head,chest}.mp4`
  - `manifest.json`. The default output is 1920x1080; `VITE_CAPTURE_WIDTH` and
    `VITE_CAPTURE_HEIGHT` may be set for a faster low-resolution smoke run.

The dev toolbar now includes a scenario selector. `RENDER CORPUS` renders all
registered scenarios in order, writing four production-camera clips plus a
manifest per scenario under `renders/<scenario-id>/`. `npm run verify:scenarios`
checks registry order, 45-60 s duration, validation, fixture shape, and the
sensor dust, way-lube, and ATC jam state transitions.

## Factory of sims

The app is no longer one hardcoded cell with a fixed scenario registry; it is a
corpus generator built from layered specs (`src/factory/`):

- `rng.ts` - pure mulberry32 seeded RNG. Factory contract: a root seed fully
  determines the corpus - same seed, byte-identical specs (geometry, beat
  timings, narration picks), so generated footage is reproducible ground truth.
- `environment.ts` - `EnvSpec` + `generateEnvironment(seed)`: whole-room
  orientation (4 yaws), ATC pod side, shop-floor palette, work light, and fog.
  Scenario scripts stay authored in the machine frame and map into world space
  via `toWorld`, so any template runs in any environment unmodified.
  `LOCKED_ENV` reproduces the original Phase-0 look exactly.
- `vocab.ts` + `scenario-gen.ts` - parametric twins of all three locked failure
  modes (sensor-trip, way-lube, atc-jam) in a template registry: seeded
  narration picks from ground-truth-preserving banks plus beat-timing jitter.
  ATC-jam anchors flip with the environment's ATC side so they track the
  mirrored pod. Output is a plain `ScenarioDef`, so drive/apply/capture run
  generated scenarios unmodified.
- `plan.ts` - `planFactory(rootSeed, { envCount, perEnv })`: seed -> environments
  -> per-scenario sub-seeds. `perEnv` cycles through every template, so
  `perEnv > 1` produces genuinely different failure modes per environment (and
  seeded slot repeats when it exceeds the template count). Pure data, no
  DOM/WebGL - headlessly testable.
- `world.ts` / `render.ts` / `manifest.ts` - one renderer + one scene shared
  across all jobs (cell rebuilt per environment), the existing batch pipeline
  per job, and a `FactoryCaptureManifest` adding `environment` (id, seed,
  variant, rotation, ATC side, palette) and `factory` (generator, engine
  version, template, root seed, timestamp) provenance blocks for ingest recall.
- `corpus.ts` / `corpus-save.ts` - stable on-disk export for the ingest
  pipeline (v0.3.0). RENDER FACTORY now writes `corpora/<rootSeed padded to
10>/`: `index.json` (the ingest entry point: seeds, plan options, per-
  scenario clip/manifest/script paths, lessons), `envs/<env-id>.json`,
  `scenarios/<scenario-id>.json` (ground-truth script + provenance), and
  `clips/<scenario-id>/{camera}.mp4 + manifest.json`. Paths are a pure
  function of (root seed, env id, scenario id, camera) - no timestamps - so
  re-exporting a seed overwrites in place and ingest can key on paths as
  stable recall identities. The index downloads last, certifying completeness.

### Public API (`src/factory/index.ts`, issue #9)

The package surface is the barrel. `createSimulation({ seed, shape })` returns
a `Simulation` handle whose layers derive every artifact from the seed alone:
`describe()` (what will this seed produce? pure data) → `plan()` (deterministic
execution plan) → `preview(world, i)` (step the live canvas through planned
environments; returns a restore disposer) → `render(world)` (footage; the
explicit effectful boundary) → `export(plan, results)` (stable on-disk
corpus) — or `renderAndExport()` for the composition. Specs are
JSON-serializable: a checked-in spec replays to the identical corpus on any
machine. Engine internals (`world`, `render`, `corpus-save`, `rng`, the
capture pipeline) are not barrel exports — they load lazily behind the
handle's effectful methods, so pure stages never import WebGL and the whole
public surface imports cleanly under plain Node. Every barrel export is
semver-contracted TSDoc'd API.

The ingest reader (`readCorpus` / `validateCorpusIndex` / `iterTrainingTuples`,
issues #8/#9) closes the loop on recall: it validates a corpus `index.json`
structurally — schema/version gates, required fields, path invariants (no
dot-dot escapes, correct `corpora/<seed>/` layout), seed ranges, and
env/scenario cross-references — then streams typed `TrainingTuple`s (lesson
labels + per-camera clip paths + script/manifest paths + regeneration seed)
in plan order. File access is injected via the `CorpusFilesystem` port, so
the same reader runs against Node `fs/promises` (scripts/CI/ingest) or an
in-memory/fetch adapter (browser), and a tuple's `seed` regenerates its
exported script exactly — the property that makes corpora replayable ground
truth for training.

The corpus index JSON Schema (issue #9 schema milestone) lives in
`src/factory/corpus-schema.ts` as the exported `corpusIndexJsonSchema` const
(draft 2020-12), emitted to the reusable `schemas/journeyman-corpus-index.v1.json`
artifact. verify:factory pins the artifact byte-fresh against the const,
validates generated fixtures on both sides (21 in-scope violations rejected;
tolerated variations accepted by schema _and_ reader), and runs a drift
matrix over the reader's 13 tamper mutations asserting which layer catches
which violation — 8 by both, 5 document-level rules by the reader alone. The
intended evolution (see the module's header note): if maintaining the schema
and the walker by hand starts to hurt, declare the schema once in **Zod** and
derive both artifacts from it (`zodToJsonSchema` for the schema file,
`z.infer` for the reader's types); the drift check is what makes that
migration safe to attempt.

The corpus CLI (`npm run corpus -- <list|tuples|verify> --root <dir-containing-corpora/> --seed <n>`,
issue #8 §4) inspects exported corpora from the shell using only the public
barrel: `list [--json]` prints the scenario inventory, `tuples` streams
JSONL training tuples for ingest piping, and `verify` checks every
referenced artifact (present, non-empty, provenance-coherent) with exit
codes suitable for CI. `--root` is the directory containing `corpora/`
because index paths are project-root-relative.

Dev controls (lower-left): `PLAN FACTORY` prints the corpus a seed will produce;
`PREVIEW ENV` cycles the live canvas through the planned generated environments
(rotated cell, palette, lighting + the generated scenario's beats); `RENDER
FACTORY` renders every generated job (per-camera MP4s + provenance manifest
under `renders/<scenario-id>/`). The generated scenario dropdown entries are
the same objects the planner emits.

`npm run verify:factory` proves determinism (same seed -> identical plans;
different seeds diverge), generated-scenario validity + corpus shape, template
cycling, per-mode cell-state transitions driven headlessly (dust, leak, jam),
ATC-side anchor flipping + pod mirroring, slot-repeat divergence, world binding
(`faultWorld == toWorld(env, machine-frame anchor)`), environment variety,
provenance manifest blocks, `LOCKED_ENV`/cell-builder parity, and the corpus
export layer (stable paths, complete index, seeds that replay every script,
lessons carried for ingest labels, overwrite-in-place re-export), and the
public-API contract (facade `plan()`/`describe()` equality with the engine
layers, JSON round-trip replay, spec normalization, barrel surface, hidden
internals, preview apply/restore), and the ingest reader (fresh-index
validation, plan-order tuples with full data, tuple-seed regeneration
identity, 13 tamper classes rejected with located problem paths, and a real
temp-dir export consumed back through a Node fs adapter), and the corpus
JSON Schema (fresh emitted artifact, fixture batteries on both sides, and
the reader/schema drift matrix).

## Verification

Headless smoke test (`npm run smoke`): with `npm run dev` running, launches a
Playwright-managed Chromium (`npx playwright-core install chromium` once),
asserts the capture UI wiring, validates all committed fixtures, triggers the
registry-wide RENDER CORPUS, and treats the exact on-page status line
`saved renders/: 3 scenarios + 12 clips + manifests` as the end-to-end pass
signal. Requires Node 23.6+. The smoke run persists every rendered artifact
(gitignored) under `scripts/smoke-artifacts/renders/<scenario-id>/` instead of
losing them to the browser download channel. For a fast, PR-embeddable run the
smoke server loads `.env.smoke` (640x360 capture, 0.9 Mbps composite) via
`--mode smoke`; production captures remain 1920x1080 at 12 Mbps. Each preview
webm is asserted under GitHub's 10 MB attachment limit so it can be uploaded as
a release asset and embedded inline in a PR.

Headless factory driver (`npm run factory:run`): produces a complete generated
corpus in Chromium without touching the dev UI. Same browser strategy as the
smoke test (with the CDP fallback for locked-down machines); fills the factory
panel (seed / envs / perEnv via `FACTORY_RUN_SEED`, `FACTORY_RUN_ENVS`,
`FACTORY_RUN_PER_ENV`), asserts the planned-corpus status line, triggers RENDER
FACTORY, waits for `saved corpora/<rootSeedPadded10>: N scenarios, M clips +
index.json`, then validates the exported corpus on disk under
`scripts/factory-artifacts/` (index schema, root seed, scenario count, lesson
presence, and every referenced artifact non-empty). Point
`FACTORY_RUN_URL` at any dev server; ~3 min per scenario at 640x360.
