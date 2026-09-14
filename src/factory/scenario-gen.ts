import type { ScenarioBeat, ScenarioCell, ScenarioDef } from "../scenario/types";
import { createRng, hashSeed, type Rng } from "./rng";
import { toWorld, toWorldXZ, type EnvSpec } from "./environment";
import { ATC_JAM_BANK, SENSOR_TRIP_BANK, WAY_LUBE_BANK } from "./vocab";

/** Generated ScenarioDef plus provenance for manifests and grounding. */
export interface FactoryScenario extends ScenarioDef {
  /** Template the scenario was generated from. */
  templateId: string;
  /** Repeat index of the template within its environment (0 for the first). */
  slot: number;
  /** World position the scenario's active cell state anchors to. */
  faultWorld: readonly [number, number, number];
}

/** Beat durations with seeded jitter, plus the fault onset/clear points. */
interface Timing {
  tEnd: number;
  /** Failure state appears when the walk ends. */
  failSec: number;
  /** Hands-on (inspect/wipe/reach) beat start + end. */
  handsOnStart: number;
  handsOnEnd: number;
  /** Final watch/verify beat start. */
  verifyStart: number;
  /** Failure state clears mid-verify (locked-corpus shape). */
  clearAt: number;
  /** Signal stack kicks green. */
  greenAt: number;
}

function timing(rng: Rng, tEnd: number): Timing {
  const failSec = 10;
  const listenDur = 10 + rng.range(-1.5, 1.5);
  const handsDur = 12 + rng.range(-1.5, 1.5);
  const verifyDur = 8 + rng.range(-1, 1);
  const handsOnStart = failSec + listenDur;
  const handsOnEnd = handsOnStart + handsDur;
  const verifyStart = handsOnEnd + verifyDur;
  const clearAt = handsOnEnd + verifyDur / 2;
  const greenAt = Math.min(clearAt + 3.5, tEnd - 2);
  return { tEnd, failSec, handsOnStart, handsOnEnd, verifyStart, clearAt, greenAt };
}

/** Narration times for the six standard lines, derived from the timing. */
type NarrationTimes = readonly [number, number, number, number, number, number];

function narrationTimes(t: Timing): NarrationTimes {
  return [
    2,
    t.failSec + 1,
    t.handsOnStart + 3,
    t.handsOnEnd - 4,
    t.clearAt + 1,
    Math.max(t.greenAt + 2, t.tEnd - 6),
  ];
}

/** Red->amber->green signal timeline shared by the failure/resolution arc. */
function redAmberGreen(t: Timing): ScenarioCell["signals"] {
  return [
    { tStart: 0, red: 1, amber: 0, green: 0 },
    { tStart: t.clearAt, red: 0, amber: 1, green: 0 },
    { tStart: t.greenAt, red: 0, amber: 0, green: 1 },
  ];
}

/**
 * A parametric failure-mode template: beats authored in the machine frame
 * (machine at origin, front toward +Z — the frame the locked corpus uses),
 * mapped into the environment's world frame at generation time, so any
 * template runs in any generated environment unmodified.
 */
interface Template {
  id: string;
  title: string;
  role: string;
  /** Fault ground point in machine frame (world-mapped for faultWorld). */
  faultAnchor: readonly [number, number, number];
  /** Machine-frame stand spot for the hands-on beat. */
  handsOnStandXZ: readonly [number, number];
  /** Machine-frame look point for the verify beat. */
  verifyLook: readonly [number, number, number];
  /** Lean + reach for the hands-on beat (hand target is faultAnchor). */
  lean: number;
  hand: "left" | "right";
  /** Seeded narration from the template's bank. */
  narration(rng: Rng, times: NarrationTimes): Array<{ t: number; text: string }>;
  lesson(rng: Rng): { title: string; body: string };
  /** Seeded cell timeline (fault window + signal stack). */
  cell(rng: Rng, t: Timing): ScenarioCell;
}

function buildBeats(
  template: Template,
  env: EnvSpec,
  t: Timing,
  spots: {
    approach: [number, number];
    verify: [number, number];
    faultWorld: [number, number, number];
    verifyLookWorld: [number, number, number];
    stackWorld: [number, number, number];
  },
): ScenarioBeat[] {
  const stand = toWorldXZ(env, template.handsOnStandXZ);
  return [
    {
      id: "walk_up",
      label: "Walk up to the cell",
      tStart: 0,
      tEnd: t.failSec,
      cameraHint: "side-a",
      motion: {
        pose: "walk",
        walkFrom: spots.approach,
        walkTo: spots.verify,
        look: spots.faultWorld,
      },
    },
    {
      id: "locate_fault",
      label: "Locate the fault",
      tStart: t.failSec,
      tEnd: t.handsOnStart,
      cameraHint: "head",
      motion: { pose: "stand", standAt: stand, lean: template.lean * 0.55, look: spots.faultWorld },
    },
    {
      id: "hands_on",
      label: "Step in and clear the fault",
      tStart: t.handsOnStart,
      tEnd: t.handsOnEnd,
      cameraHint: "head",
      motion: {
        pose: "wipe",
        standAt: stand,
        lean: template.lean,
        reach: { hand: template.hand, target: spots.faultWorld },
        look: spots.faultWorld,
      },
    },
    {
      id: "verify_clear",
      label: "Back off and verify the fault clears",
      tStart: t.handsOnEnd,
      tEnd: t.verifyStart,
      cameraHint: "chest",
      motion: { pose: "stand", standAt: spots.verify, lean: 0.12, look: spots.verifyLookWorld },
    },
    {
      id: "all_clear",
      label: "Signal stack confirms amber-to-green",
      tStart: t.verifyStart,
      tEnd: t.tEnd,
      cameraHint: "side-b",
      motion: { pose: "stand", standAt: spots.verify, look: spots.stackWorld },
    },
  ];
}

// ---------------------------------------------------------------------------
// sensor-trip: dust-bridged guard-door interlock sensor (machine front)
// ---------------------------------------------------------------------------

const sensorTrip: Template = {
  id: "sensor-trip",
  title: "False overtravel alarm: dust-bridged guard-door sensor",
  role: "CNC machinist troubleshooting a false X-axis overtravel alarm",
  faultAnchor: [0.42, 1.02, 0.4],
  handsOnStandXZ: [0.15, 0.72],
  verifyLook: [0.42, 1.02, 0.4],
  lean: 0.45,
  hand: "right",
  narration(rng, [t0, t1, t2, t3, t4, t5]) {
    const b = SENSOR_TRIP_BANK;
    return [
      { t: t0, text: rng.pick(b.open) },
      { t: t1, text: rng.pick(b.locate) },
      { t: t2, text: rng.pick(b.found) },
      { t: t3, text: rng.pick(b.wipe) },
      { t: t4, text: rng.pick(b.verify) },
      { t: t5, text: rng.pick(b.clear) },
    ];
  },
  lesson(rng) {
    return {
      title: rng.pick(SENSOR_TRIP_BANK.lessonTitles),
      body: rng.pick(SENSOR_TRIP_BANK.lessonBodies),
    };
  },
  cell(_rng, t) {
    return {
      dust: { appearsAt: t.failSec, clearedAt: t.clearAt },
      wayLube: null,
      atc: null,
      signals: redAmberGreen(t),
    };
  },
};

// ---------------------------------------------------------------------------
// way-lube: leaking metering junction on the guard-side frame (machine front)
// ---------------------------------------------------------------------------

const wayLube: Template = {
  id: "way-lube",
  title: "Way-lube failure: dry guideway and leaking metering line",
  role: "CNC machinist diagnosing a dry slideway and way-lube leak",
  faultAnchor: [-0.3, 1.0, 0.35],
  handsOnStandXZ: [-0.2, 0.8],
  verifyLook: [-0.3, 1.0, 0.35],
  lean: 0.38,
  hand: "left",
  narration(rng, [t0, t1, t2, t3, t4, t5]) {
    const b = WAY_LUBE_BANK;
    const verify = rng.pick(b.verify);
    return [
      { t: t0, text: rng.pick(b.open) },
      { t: t1, text: rng.pick(b.listen) },
      { t: t2, text: rng.pick(b.inspect) },
      { t: t3, text: rng.pick(b.prime) },
      { t: t4, text: verify },
      // Closing line picks a different phrasing than the verify line.
      { t: t5, text: pickOther(rng, b.verify, verify) },
    ];
  },
  lesson(rng) {
    return {
      title: rng.pick(WAY_LUBE_BANK.lessonTitles),
      body: rng.pick(WAY_LUBE_BANK.lessonBodies),
    };
  },
  cell(rng, t) {
    // The leak rises during the hands-on beat and is wiped away mid-verify.
    const riseAt = t.handsOnStart + 2 + rng.range(0, 3);
    return {
      dust: null,
      wayLube: { appearsAt: riseAt, clearedAt: t.clearAt },
      atc: null,
      signals: [
        { tStart: 0, red: 0, amber: 1, green: 0 },
        { tStart: Math.max(t.failSec, riseAt + 1), red: 1, amber: 0, green: 0 },
        { tStart: t.clearAt, red: 0, amber: 1, green: 0 },
        { tStart: t.greenAt, red: 0, amber: 0, green: 1 },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// atc-jam: carousel pocket jam (anchors flip with the environment's ATC side)
// ---------------------------------------------------------------------------

const atcJam: Template = {
  id: "atc-jam",
  title: "ATC jam: carousel stopped between tool pockets",
  role: "CNC machinist clearing an automatic tool changer indexing jam",
  // Anchors resolve at generation time via atcSide (pod-relative points).
  faultAnchor: [1.85, 1.26, -0.7],
  handsOnStandXZ: [1.7, 0.35],
  verifyLook: [2.1, 1.25, -1],
  lean: 0.34,
  hand: "right",
  narration(rng, [t0, t1, t2, t3, t4, t5]) {
    const b = ATC_JAM_BANK;
    const verify = rng.pick(b.verify);
    return [
      { t: t0, text: rng.pick(b.open) },
      { t: t1, text: rng.pick(b.observe) },
      { t: t2, text: rng.pick(b.inspect) },
      { t: t3, text: rng.pick(b.clear) },
      { t: t4, text: verify },
      // Closing line picks a different phrasing than the verify line.
      { t: t5, text: pickOther(rng, b.verify, verify) },
    ];
  },
  lesson(rng) {
    return {
      title: rng.pick(ATC_JAM_BANK.lessonTitles),
      body: rng.pick(ATC_JAM_BANK.lessonBodies),
    };
  },
  cell(_rng, t) {
    return {
      dust: null,
      wayLube: null,
      atc: { appearsAt: t.failSec, clearedAt: t.clearAt },
      signals: redAmberGreen(t),
    };
  },
};

/** Registry of parametric failure-mode templates, keyed by template id. */
export const TEMPLATE_REGISTRY: Readonly<Record<string, Template>> = {
  "sensor-trip": sensorTrip,
  "way-lube": wayLube,
  "atc-jam": atcJam,
};

/** Template ids in canonical (locked-corpus) order. */
export const TEMPLATE_IDS = ["sensor-trip", "way-lube", "atc-jam"] as const;

/**
 * Generate one ScenarioDef deterministically from (env, template id, slot): a
 * parametric twin of a locked failure mode expressed through seeded
 * environment binding, narration picks, and beat-timing jitter. Output is a
 * plain ScenarioDef, so the existing drive/apply/capture stack runs generated
 * scenarios unmodified.
 *
 * Scripts are authored in the machine frame (the frame the locked corpus
 * uses) and mapped into the environment's world frame, so any template runs
 * in any generated environment. ATC-side-relative anchors flip with
 * env.atcSide; the ATC pod itself is mirrored by the cell builder.
 */
export function generateScenario(
  env: EnvSpec,
  templateId: string,
  durationSec = 50,
  slot = 0,
): FactoryScenario {
  const template = TEMPLATE_REGISTRY[templateId];
  if (!template) throw new Error(`unknown factory template: ${templateId}`);

  // The slot disambiguates repeated templates within one environment and
  // diversifies their timing/narration.
  const rng = createRng(hashSeed(`${env.seed}:${env.id}:${templateId}:${slot}`));
  const t = timing(rng, durationSec);

  // ATC templates anchor to the pod, which mirrors with the environment's
  // ATC side (the cell builder mirrors the pod geometry to match).
  const side = templateId === "atc-jam" ? env.atcSide : 1;
  const flip = (p: readonly [number, number, number]): [number, number, number] => [
    p[0] * side,
    p[1],
    p[2],
  ];
  const faultWorld = toWorld(env, flip(template.faultAnchor));

  const verify = toWorldXZ(env, [0, 0.95]);
  const approach = approachSpot(env, verify, rng);
  const stackWorld = toWorld(env, [-4.6, 2.5, -4.3]);
  const verifyLookWorld = toWorld(env, flip(template.verifyLook));
  const times = narrationTimes(t);

  const beats = buildBeats(
    { ...template, handsOnStandXZ: flipXZ(template.handsOnStandXZ, side) },
    env,
    t,
    { approach, verify, faultWorld, verifyLookWorld, stackWorld },
  );

  return {
    id: slot === 0 ? `${templateId}-${env.id}` : `${templateId}-${env.id}-${slot}`,
    templateId,
    slot,
    title: template.title,
    role: template.role,
    durationSec: t.tEnd,
    fps: 30,
    cameras: ["side-a", "side-b", "head", "chest"],
    beats,
    narration: template.narration(rng, times),
    lesson: template.lesson(rng),
    cell: template.cell(rng, t),
    faultWorld,
  };
}

function flipXZ(p: readonly [number, number], side: 1 | -1): [number, number] {
  return [p[0] * side, p[1]];
}

/** Pick an element different from `not` (banks always have >= 2 entries). */
function pickOther<T>(rng: Rng, items: readonly T[], not: T): T {
  const choice = rng.pick(items);
  if (choice !== not) return choice;
  return items[(items.indexOf(not) + 1) % items.length]!;
}

/**
 * Approach spot: ~2.2 m straight out from the machine front (world-computed)
 * with a small seeded lateral offset, mirroring the locked corpus walk arc in
 * every generated orientation.
 */
function approachSpot(env: EnvSpec, verify: readonly [number, number], rng: Rng): [number, number] {
  const front = toWorldXZ(env, [0, 1]);
  const lateral = toWorldXZ(env, [1, 0]);
  const j = rng.range(-0.4, 0.4);
  return [verify[0] + front[0] * 2.2 + lateral[0] * j, verify[1] + front[1] * 2.2 + lateral[1] * j];
}
