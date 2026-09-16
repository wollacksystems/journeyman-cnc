import type { Rng } from "./rng";

/**
 * Environment layer: generated cells the scenario templates run in.
 *
 * A generated environment is the locked machine cell re-arranged: the whole
 * room (machine, enclosure, ATC pod, signal stack) is placed in one of four
 * orientations, the tool-changer pod can mirror to either side, and palette +
 * lighting + fog vary. Scenario scripts are authored in the machine frame
 * (machine at the origin, front toward +Z, the frame every locked scenario
 * already uses) and mapped into world space by `toWorld`, so any template
 * runs in any generated environment unmodified.
 *
 * @module
 * @example
 * ```ts
 * import { createRng } from "@/factory/rng.ts";
 * import { generateEnvironment, LOCKED_ENV, toWorldXZ } from "@/factory/environment.ts";
 *
 * const env = generateEnvironment(31337, 0, createRng(31337));
 * env.id;        // "env-00"
 * env.variant;   // flavor label, e.g. "tool-crib-corner"
 * env.atcSide;   // 1 | -1 — which side the tool changer sits on
 *
 * // Machine-frame coordinates map into world space per environment:
 * const [x, z] = toWorldXZ(env, [0, 0, 2]); // a point 2m in front of the machine
 * ```
 */
export interface EnvSpec {
  id: string;
  seed: number;
  /** Human-readable flavor label baked into manifests. */
  variant: string;
  /** Whole-room yaw in radians (0, ±π/2, π). */
  machineRotation: number;
  /** Which side of the column the ATC pod sits on (machine frame +X or -X). */
  atcSide: 1 | -1;
  palette: EnvPalette;
  /** Local work-light position jitter (subtle, keeps shadows per-environment). */
  workLight: { x: number; y: number; z: number; intensity: number };
  fog: { near: number; far: number };
}

export interface EnvPalette {
  name: string;
  background: number;
  fog: number;
  floor: number;
  wall: number;
  machine: number;
  machineDark: number;
  accent: number;
}

/** Named shop-floor palettes; the generator picks per environment. */
export const ENV_PALETTES: readonly EnvPalette[] = [
  {
    name: "graphite",
    background: 0x11141a,
    fog: 0x11141a,
    floor: 0x2b2f36,
    wall: 0x3f4754,
    machine: 0x6b7280,
    machineDark: 0x374151,
    accent: 0x9ca3af,
  },
  {
    name: "cool-blue",
    background: 0x0d1218,
    fog: 0x0d1218,
    floor: 0x232a33,
    wall: 0x35414f,
    machine: 0x5d7285,
    machineDark: 0x2f3d4a,
    accent: 0x8fa3bf,
  },
  {
    name: "warm-steel",
    background: 0x14110d,
    fog: 0x14110d,
    floor: 0x2e2921,
    wall: 0x4a4238,
    machine: 0x7a7166,
    machineDark: 0x453e34,
    accent: 0xb0a390,
  },
  {
    name: "sage-shop",
    background: 0x0f1410,
    fog: 0x0f1410,
    floor: 0x242b24,
    wall: 0x3a473c,
    machine: 0x6b7a6e,
    machineDark: 0x37423a,
    accent: 0x9fb3a1,
  },
];

const VARIANTS = ["night-shift", "day-shift", "swing-shift", "weekend-crew"] as const;

/**
 * Generate a deterministic environment from a seed. `index` disambiguates
 * environments produced from the same seed inside one corpus run.
 *
 * @param seed - Environment seed; same seed + same `index` -> same EnvSpec.
 * @param index - Position in the corpus run; becomes the `env-NN` id suffix.
 * @param rng - Random stream (callers pass `createRng(seed)`; passing a
 *   stream shared with other draws would couple the draws).
 * @example
 * ```ts
 * import { createRng } from "@/factory/rng.ts";
 * import { generateEnvironment } from "@/factory/environment.ts";
 *
 * const a = generateEnvironment(42, 0, createRng(42));
 * const b = generateEnvironment(42, 0, createRng(42));
 * a.variant === b.variant; // true — pure function of the seed
 * ```
 */
export function generateEnvironment(seed: number, index: number, rng: Rng): EnvSpec {
  const rotations = [0, Math.PI / 2, -Math.PI / 2, Math.PI];
  return {
    id: `env-${index.toString().padStart(2, "0")}`,
    seed,
    variant: rng.pick(VARIANTS),
    machineRotation: rng.pick(rotations),
    atcSide: rng.chance(0.5) ? 1 : -1,
    palette: rng.pick(ENV_PALETTES),
    workLight: {
      x: rng.range(0.1, 0.7) * (rng.chance(0.5) ? 1 : -1),
      y: rng.range(2.0, 2.4),
      z: rng.range(1.2, 1.8),
      intensity: rng.range(11, 16),
    },
    fog: { near: rng.range(12, 15), far: rng.range(28, 34) },
  };
}

/**
 * The locked Phase-0 look expressed as an environment spec: the default cell
 * the hand-authored corpus was authored against (graphite palette, identity
 * rotation, ATC on +X, default work light and fog). Running the app under
 * LOCKED_ENV reproduces the original sim exactly.
 */
export const LOCKED_ENV: EnvSpec = {
  id: "env-locked",
  seed: 0,
  variant: "locked-corpus",
  machineRotation: 0,
  atcSide: 1,
  palette: ENV_PALETTES[0]!,
  workLight: { x: 0.4, y: 2.2, z: 1.5, intensity: 14 },
  fog: { near: 14, far: 32 },
};

/** Rotate an [x, z] machine-frame point by the environment yaw. */
function rotateXZ(x: number, z: number, yaw: number): [number, number] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [x * c + z * s, -x * s + z * c];
}

/**
 * Map a machine-frame point (the frame every scenario template is authored
 * in: machine at origin, front toward +Z) into the environment's world frame.
 * `y` passes through unchanged.
 */
export function toWorld(
  env: EnvSpec,
  point: readonly [number, number, number],
): [number, number, number] {
  const [x, z] = rotateXZ(point[0], point[2], env.machineRotation);
  return [x, point[1], z];
}

/** Map a machine-frame ground point ([x, z] avatar coordinates) to world. */
export function toWorldXZ(env: EnvSpec, point: readonly [number, number]): [number, number] {
  return rotateXZ(point[0], point[1], env.machineRotation);
}

/** Unit vector of the machine front (+Z in machine frame) in world space. */
export function machineFrontXZ(env: EnvSpec): [number, number] {
  return rotateXZ(0, 1, env.machineRotation);
}

/** Right-hand perpendicular of the machine front in world space. */
export function machinePerpXZ(env: EnvSpec): [number, number] {
  const [fx, fz] = machineFrontXZ(env);
  return [fz, -fx];
}
