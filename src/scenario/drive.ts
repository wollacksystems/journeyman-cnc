import type { ScenarioBeat, ScenarioDef } from "./types";
import { beatAt, clamp01, lerp, smoothstep } from "./types";

export interface ScenarioState {
  /** Simulation time (s) the state was driven to. */
  t: number;
  beat: ScenarioBeat;
  /** Progress through the active beat, 0..1. */
  progress: number;
  avatar: {
    /** World [x, z] the avatar root stands at. */
    position: readonly [number, number];
    /** Forward torso lean 0..1 (1 = almost horizontal). */
    lean: number;
    /** True while the walk beat is active (drives gait sway). */
    walking: boolean;
    /** World-space point the face looks toward; avatar faces down local -Z. */
    lookAt: readonly [number, number, number];
    /** Active reach pose, or null for arms at rest. */
    reach: { hand: "left" | "right"; target: readonly [number, number, number] } | null;
    /** True during the wipe sweep (hand oscillates around the reach target). */
    wiping: boolean;
  };
  cell: {
    /** Sensor dust contamination 0..1. */
    dust: number;
    /** Way-lube leak severity 0..1. */
    wayLube: number;
    /** ATC carousel jam severity 0..1. */
    atcJammed: number;
    /** Deterministic ATC carousel angle. */
    atcRotation: number;
    signal: { red: number; amber: number; green: number };
  };
}

/** Ramp 0->1 across the first `enter` fraction of a beat, then back down across the last `exit`. */
function easeTriangle(p: number, enter: number, exit: number): number {
  const up = smoothstep(clamp01(p / enter));
  const down = smoothstep(clamp01((1 - p) / exit));
  return Math.min(up, down);
}

/**
 * Deterministic scenario state at time t. Pure function of (def, t): no wall
 * clock, no random, no cumulative state. This is what makes batch capture
 * frame-aligned: frame N of any camera clip always corresponds to sim time
 * N / fps.
 */
export function driveScenario(def: ScenarioDef, t: number): ScenarioState {
  const time = Math.min(Math.max(t, 0), def.durationSec - 1e-6);
  const beat = beatAt(def, time);
  const progress = clamp01((time - beat.tStart) / Math.max(1e-6, beat.tEnd - beat.tStart));
  const motion = beat.motion;

  let position: readonly [number, number];
  if (motion.walkFrom && motion.walkTo) {
    const e = smoothstep(progress);
    position = [
      lerp(motion.walkFrom[0], motion.walkTo[0], e),
      lerp(motion.walkFrom[1], motion.walkTo[1], e),
    ];
  } else {
    position = motion.standAt ?? [0, 0.95];
  }

  const leanBase = motion.lean ?? 0;
  const lean =
    motion.pose === "wipe"
      ? leanBase * easeTriangle(progress, 0.28, 0.28)
      : leanBase * easeTriangle(progress, 0.3, 0.35);

  const wiping = motion.pose === "wipe";
  let reach = motion.reach ?? null;
  if (wiping && reach) {
    const sweep = Math.sin(progress * Math.PI * 3) * 0.28;
    reach = {
      hand: reach.hand,
      target: [reach.target[0] + sweep, reach.target[1], reach.target[2]],
    };
  }

  const lookAt = motion.look ?? (reach ? reach.target : [0, 1.3, -1]);

  const dustSpec = def.cell.dust;
  const dust =
    dustSpec === null
      ? 0
      : time < dustSpec.appearsAt
        ? 0
        : time >= dustSpec.clearedAt
          ? Math.max(0, 1 - (time - dustSpec.clearedAt) / 0.5)
          : 1;

  const wayLubeSpec = def.cell.wayLube;
  const wayLube =
    wayLubeSpec === null
      ? 0
      : time < wayLubeSpec.appearsAt
        ? 0
        : time >= wayLubeSpec.clearedAt
          ? Math.max(0, 1 - (time - wayLubeSpec.clearedAt) / 1)
          : Math.min(1, (time - wayLubeSpec.appearsAt) / 2);

  const atcSpec = def.cell.atc;
  const atcJammed =
    atcSpec === null
      ? 0
      : time < atcSpec.appearsAt
        ? 0
        : time >= atcSpec.clearedAt
          ? Math.max(0, 1 - (time - atcSpec.clearedAt) / 0.75)
          : 1;
  const atcRotation = atcJammed > 0.5 ? (atcSpec?.appearsAt ?? 0) * 1.8 : time * 1.8;

  let signal = def.cell.signals[def.cell.signals.length - 1];
  for (const s of def.cell.signals) {
    if (time >= s.tStart) signal = s;
  }

  return {
    t: time,
    beat,
    progress,
    avatar: {
      position,
      lean,
      walking: motion.pose === "walk",
      lookAt,
      reach,
      wiping,
    },
    cell: {
      dust: Math.max(0, Math.min(1, dust)),
      wayLube: Math.max(0, Math.min(1, wayLube)),
      atcJammed: Math.max(0, Math.min(1, atcJammed)),
      atcRotation,
      signal: { red: signal?.red ?? 0, amber: signal?.amber ?? 0, green: signal?.green ?? 0 },
    },
  };
}
