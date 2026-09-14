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

## Verification

Headless smoke test (`npm run smoke`): with `npm run dev` running, launches a
Playwright-managed Chromium (`npx playwright-core install chromium` once),
asserts the capture UI wiring, validates all committed fixtures, triggers the
registry-wide RENDER CORPUS, and treats the exact on-page status line
`saved renders/: 3 scenarios + 12 clips + manifests` as the end-to-end pass
signal. Requires Node 23.6+. For a complete local smoke without waiting for
1080p encoding, start Vite with `VITE_CAPTURE_WIDTH=256 VITE_CAPTURE_HEIGHT=144`;
the default capture remains 1920x1080.
