# journeyman-sim

Synthetic CNC training environment for the Journeyman pipeline: a headless-capable
Three.js rig that renders scripted industrial scenarios, records them per camera,
and feeds the footage through the real ingest path (frames → embeddings →
transcripts → RAG) as ground-truth-labeled fixtures.

## Approach (locked)

- Plain Three.js + TypeScript + Vite. No physics engine.
- 1080p / 30 fps. Primitive-first geometry (boxes, cylinders, capsules).
- Three scripted scenarios (45–60 s each): false sensor trip, way-lube failure,
  ATC jam. Plain-text narration with TTS; the transcript is ground truth.
- Rendered composite proof view for deliverables; the live inspector window is
  dev-only.
- One WebGLRenderer, six scissored viewports: 2 static side cams, head + chest
  cams on a primitive avatar, 2 debug cams.
- Commit JSON manifests + small smoke fixtures to the repo; full-resolution
  renders stay in gitignored local `renders/`.

## Status

Phase 0 — repo bootstrap. Feature work happens on the `synthetic-environment`
branch (see `worktrees/` conventions in the parent workspace).
