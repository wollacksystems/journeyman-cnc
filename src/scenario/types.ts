import type { CameraId } from "../rig";

/** Interpolate x in [0,0]..[1,1] with Hermite smoothstep (3x^2-2x^3). */
export function smoothstep(x: number): number {
  const clamped = x < 0 ? 0 : x > 1 ? 1 : x;
  return clamped * clamped * (3 - 2 * clamped);
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export type ScenarioPose = "walk" | "stand" | "wipe";

export interface ReachPose {
  hand: "left" | "right";
  /** World-space point the hand center reaches toward. */
  target: readonly [number, number, number];
}

/**
 * Declarative motion for one beat. Exactly one of {walkFrom/To} or {standAt}
 * is required so every frame's avatar position is a pure function of time
 * (no cumulative state between frames).
 */
export interface ScenarioBeatMotion {
  pose: ScenarioPose;
  /** Linear walk from [x,z] to [x,z], eased with smoothstep over the beat. */
  walkFrom?: readonly [number, number];
  walkTo?: readonly [number, number];
  /** Fixed [x,z] the avatar stands at for this beat. */
  standAt?: readonly [number, number];
  /** Max forward torso lean 0..1 (ramps in and out across the beat). */
  lean?: number;
  /** Point the head/face looks at (world space). Defaults to the reach/travel direction. */
  look?: readonly [number, number, number];
  /** Reach pose (arms animate to the target; wipe sweeps around it). */
  reach?: ReachPose;
}

export interface ScenarioBeat {
  id: string;
  label: string;
  tStart: number;
  tEnd: number;
  /** Primary camera for the beat, honored in the ingest timeline for clip playback. */
  cameraHint: CameraId;
  motion: ScenarioBeatMotion;
}

export interface NarrationLine {
  t: number;
  text: string;
}

export interface ScenarioLesson {
  title: string;
  body: string;
}

export interface SignalState {
  tStart: number;
  red: number;
  amber: number;
  green: number;
}

export interface ScenarioCell {
  /** Guard-door sensor dust: appears at A, cleared at B (0 = none). */
  dust: { appearsAt: number; clearedAt: number } | null;
  /** Way-lube leak: rises at A and can be wiped at B (0 = none). */
  wayLube: { appearsAt: number; clearedAt: number } | null;
  /** ATC carousel jam: freezes the carousel at A and can be cleared at B. */
  atc: { appearsAt: number; clearedAt: number } | null;
  signals: readonly SignalState[];
}

export interface ScenarioDef {
  id: string;
  title: string;
  role: string;
  durationSec: number;
  fps: number;
  /** Production cameras rendered for the corpus (a subset of the rig). */
  cameras: readonly CameraId[];
  beats: readonly ScenarioBeat[];
  narration: readonly NarrationLine[];
  lesson: ScenarioLesson;
  cell: ScenarioCell;
}

/** Active beat by simulation time (offscreen tails to the first/last beat). */
export function beatAt(def: ScenarioDef, t: number): ScenarioBeat {
  const clamped = Math.min(Math.max(t, 0), def.durationSec - 1e-6);
  for (const beat of def.beats) {
    if (clamped >= beat.tStart && clamped < beat.tEnd) return beat;
  }
  const last = def.beats[def.beats.length - 1];
  if (last) return last;
  // Only reachable for an unvalidated scenario; fail loudly instead of
  // returning an empty beat.
  throw new Error(`Scenario "${def.id}" has no beats`);
}

/** Returns a list of validation problems (empty when the scenario is well-formed). */
export function validateScenario(def: ScenarioDef): string[] {
  const problems: string[] = [];
  if (def.durationSec <= 0) problems.push("durationSec must be > 0");
  if (def.fps <= 0) problems.push("fps must be > 0");
  if (def.beats.length === 0) problems.push("at least one beat required");
  if (def.cameras.length === 0) problems.push("at least one production camera required");

  const sorted = [...def.beats].sort((a, b) => a.tStart - b.tStart);
  let prevEnd = 0;
  for (const beat of sorted) {
    if (beat.tStart < prevEnd) problems.push(`${beat.id}: starts before previous beat ends`);
    if (beat.tEnd <= beat.tStart) problems.push(`${beat.id}: tEnd <= tStart`);
    const motion = beat.motion;
    const hasWalk = motion.walkFrom !== undefined || motion.walkTo !== undefined;
    if (motion.pose === "walk" && !(motion.walkFrom && motion.walkTo)) {
      problems.push(`${beat.id}: walk pose requires walkFrom and walkTo`);
    }
    if (motion.pose !== "walk" && !motion.standAt) {
      problems.push(`${beat.id}: non-walk pose requires standAt`);
    }
    if (motion.pose === "walk" && motion.standAt) {
      problems.push(`${beat.id}: standAt conflicts with walk pose`);
    }
    if (hasWalk && motion.standAt) {
      problems.push(`${beat.id}: standAt conflicts with walkFrom/walkTo`);
    }
    prevEnd = beat.tEnd;
  }
  const firstBeat = sorted[0];
  if (firstBeat && firstBeat.tStart !== 0) problems.push("first beat must start at 0");
  const lastBeat = sorted[sorted.length - 1];
  if (lastBeat && lastBeat.tEnd > def.durationSec + 1e-6) {
    problems.push("last beat runs past durationSec");
  }

  const narrationT = def.narration.map((n) => n.t);
  if (narrationT.some((t) => t < 0 || t >= def.durationSec)) {
    problems.push("narration timestamps must fall in [0, durationSec)");
  }
  return problems;
}
