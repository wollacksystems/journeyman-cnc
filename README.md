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

A generated API reference (TypeDoc, single-entry `src/factory/index.ts`) is
published to GitHub Pages by CI: see
<https://wollacksystems.github.io/journeyman-sim/>. It regenerates on every
push to `main` via `.github/workflows/pages.yml`; the site itself is never
committed (regenerate locally with `npm run docs:api`).

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
the reader/schema drift matrix), and an import-hygiene gate (issue #12):
root-reaching imports use the `@/` alias declared in `tsconfig.json` and
derived into Vite's `resolve.alias`, and the suite fails if any `../src/`
relative chain regrows.

## Verification

CI (`.github/workflows/ci.yml`) runs the headless gate on every PR and push to
`main`: typecheck, lint, format check, the three verify suites, and build. The
capture flows (`npm run smoke`, `npm run factory:run`) need a dev server +
Chromium and minutes per scenario, so they stay local/manual.

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

## Brag footage

The 20-second Journeyman launch video is cut from this rig's production renders,
so the footage has a published, checksummed home instead of living only in a
gitignored `renders/` on whichever machine happened to render it
(`npm run footage -- <capture|bundle|publish|fetch>`):

```text
capture  render at 1920x1080                -> scripts/footage-artifacts/renders/<scenario>/{side-a,side-b,head,chest}.mp4 + manifest.json
bundle   validate + write the index         -> scripts/footage-artifacts/bundle/footage.json (sha256 per clip, beats + narration timeline)
publish  gh release create/upload           -> release `footage-corpus-v1` (12 clips + 3 manifests + footage.json)
fetch    download + verify into renders/    -> scripts/footage-artifacts/footage.lock.json
```

`npm run footage:capture` starts its own dev server and stops it when the run
ends, so there is nothing to remember to launch and nothing to compete with a
dev server someone else already has open. That server runs with
`JOURNEYMAN_CAPTURE_SERVER=1`, which makes `vite.config.ts` watch nothing and
disable HMR: a 1080p corpus is ~4 minutes of software-GL rendering per camera,
and a single reload in that window discards the in-flight batch and resets the
sim clock. Because no edit can disturb a run, the tree stays safe to work in
while it renders. Point it at an existing server with `--url` (or `FOOTAGE_URL`)
if you want to watch the batch in a browser you already have open, and use
`FOOTAGE_SERVER_MODE=smoke` to exercise the whole path at 640x360.

The smoke path above stays what it is — a 640x360 preview pass whose composites
ride along on `preview-corpus-v1` for PR embeds. `footage` is the production
path, and it refuses to pretend otherwise: `bundle` and `fetch` both reject a
sub-1080p corpus unless `--allow-preview` is passed deliberately, and every clip
is validated as a real MP4 (file-type box up front, movie box present) rather
than trusted from the on-page status line. That check exists because the
2026-09-14 preview batch reported success while `atc-jam/*.mp4` landed as 0-byte
stubs: the page finalizes the status line before the browser finishes writing the
downloads, so both drivers now drain the download channel before closing the
browser.

```bash
npm run footage:capture                # resumes: re-run it as often as you like
npm run footage:bundle
npm run footage:publish -- --dry-run   # then without --dry-run (needs gh + write access)
npm run footage:fetch -- --tag footage-corpus-v1
```

Capture is a resume loop, not a one-shot. It renders at most
`FOOTAGE_CAMERAS_PER_ATTEMPT` cameras (4) per page load and re-plans from disk
between chunks, so an interrupted run costs at most one chunk instead of the
whole corpus, and simply re-running the command picks up where it stopped.
Every status read is also bounded, so a renderer that wedges mid-clip is
reported as a wedge in under a minute rather than hanging the driver, which is
how a 56-minute silent stall once passed for a slow render. `FOOTAGE_ATTEMPTS`
(5) bounds consecutive _failed_ chunks, not total chunks.

Consumers (the video edit, the ingest pipeline, the marketing site) only need
`fetch`: it pulls the index and clips over plain HTTPS from the release, so no
checkout, token, or `gh` install is required, and it is idempotent — a re-run
refetches only what is missing or whose sha256 does not match. `--check` verifies
a local renders directory against the published index without downloading.

So a build that needs the clips fetches them as a step rather than vendoring
them, and CI runs `npm run footage:fetch` on every push as its own job — the
corpus is a build input, so a release that goes missing or an index whose
checksums no longer match should fail loudly instead of quietly shipping a
stale edit. It stays a separate job so a code-only PR is never blocked by a
release-side problem.
