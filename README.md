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
ingest). Phase 3 stretches the sensor-trip beats to the locked 45-60 s and adds
way-lube + ATC jam scenarios.

Batch outputs land in gitignored `renders/<scenario-id>/`; small fixtures are
committed. Feature work happens on the `synthetic-capture` branch (see
`worktrees/` conventions in the parent workspace).

## Phase 2 capture flow (dev controls)

The dev toolbar (lower-left) exposes two captures:

- `REC COMPOSITE` - real-time `canvas.captureStream` + `MediaRecorder` webm of
  the 6-viewport composite, wall-clock loop reset to t=0.
- `RENDER CORPUS` - deterministic offline batch. For each production camera the
  scenario is driven frame-by-frame (frame N always = sim time N / fps) and
  encoded straight to MP4 by mediabunny's `CanvasSource` (keyframe every 1 s).
  Saves `renders/<scenario-id>/{side-a,side-b,head,chest}.mp4` + `manifest.json`.

The manifest records capture identity (UTC, engine version), per-camera
intrinsics read back from the live rig, the beat/narration timeline (ground
truth), and the lesson. That timeline is what the later ingest + demo app uses
to label frames/embeddings and to seek clips during answers.

## Verification

Headless smoke test (`npm run smoke`): with `npm run dev` running, launches a
Playwright-managed Chromium (`npx playwright-core install chromium` once),
asserts the capture UI wiring, triggers RENDER CORPUS, and treats the on-page
status line `saved renders/<scenario>/: N clips + manifest` as the end-to-end
pass signal. Requires Node 23.6+. On machines where Playwright's default
launch handshake hangs (some EDR setups), the script auto-falls back to
CDP-over-HTTP (`SMOKE_USE_CDP=1` forces it). Runs under Node, not Bun (Bun's
runtime shim breaks Playwright's WebSocket connection).
