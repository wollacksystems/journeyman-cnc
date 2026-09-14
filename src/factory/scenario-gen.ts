import type { ScenarioBeat, ScenarioCell, ScenarioDef } from "../scenario/types";
import { createRng, hashSeed, type Rng } from "./rng";
import { toWorld, toWorldXZ, type EnvSpec } from "./environment";
import { SENSOR_TRIP_BANK } from "./vocab";

/** Generated ScenarioDef plus provenance for manifests and grounding. */
export interface FactoryScenario extends ScenarioDef {
  /** Template the scenario was generated from. */
  templateId: string;
  /** Repeat index of the template within its environment (0 for the first). */
  slot: number;
  /** World position the scenario's active cell state anchors to. */
  faultWorld: readonly [number, number, number];
}

/**
 * Generate one ScenarioDef deterministically from (env, template id): a
 * parametric twin of the locked sensor-trip failure expressed through seeded
 * environment binding, narration picks, and beat timing jitter. Output is a
 * plain ScenarioDef, so the existing drive/apply/capture stack runs generated
 * scenarios unmodified.
 *
 * Scenario scripts are authored in the machine frame (the frame the locked
 * corpus uses) and mapped into the environment's world frame, so any template
 * runs in any generated environment.
 */
export function generateScenario(
  env: EnvSpec,
  templateId: string,
  durationSec = 50,
  slot = 0,
): FactoryScenario {
  // The slot disambiguates repeated templates within one environment (when
  // perEnv exceeds the template count) and diversifies their timing/narration.
  const rng = createRng(hashSeed(`${env.seed}:${env.id}:${templateId}:${slot}`));
  const tEnd = durationSec;
  const failSec = 10; // failure state appears
  const inspectDur = 10 + rng.range(-1.5, 1.5); // locate beat
  const wipeDur = 12 + rng.range(-1.5, 1.5); // hands-on beat
  const verifyDur = 8 + rng.range(-1, 1); // step back + watch stack
  const wipeEnd = failSec + inspectDur + wipeDur;
  // Dust clears mid-verify (the locked corpus clears at 35 of a 32-40 beat).
  const clearAt = wipeEnd + verifyDur / 2;
  const greenAt = clearAt + 3.5;

  // Anchor binding: machine-frame anchor points mapped into world space.
  const faultWorld = toWorld(env, [0.42, 1.02, 0.4]); // guard sensor face
  const stand = toWorldXZ(env, [0.15, 0.72]); // step-in spot at the door
  const verify = toWorldXZ(env, [0, 0.95]); // verify spot in front of the cell
  const approach = approachSpot(env, verify, rng);

  const beats: ScenarioBeat[] = [
    {
      id: "walk_up",
      label: "Walk up to the cell",
      tStart: 0,
      tEnd: failSec,
      cameraHint: "side-a",
      motion: { pose: "walk", walkFrom: approach, walkTo: verify, look: faultWorld },
    },
    {
      id: "locate_sensor",
      label: "Locate the guard-door sensor",
      tStart: failSec,
      tEnd: failSec + inspectDur,
      cameraHint: "head",
      motion: { pose: "stand", standAt: stand, lean: 0.25, look: faultWorld },
    },
    {
      id: "wipe_sensor",
      label: "Step in and wipe the sensor clean",
      tStart: failSec + inspectDur,
      tEnd: wipeEnd,
      cameraHint: "head",
      motion: {
        pose: "wipe",
        standAt: stand,
        lean: 0.45,
        reach: { hand: "right", target: faultWorld },
        look: faultWorld,
      },
    },
    {
      id: "verify_clear",
      label: "Back off and verify the sensor clears",
      tStart: wipeEnd,
      tEnd: wipeEnd + verifyDur,
      cameraHint: "chest",
      motion: { pose: "stand", standAt: verify, lean: 0.12, look: faultWorld },
    },
    {
      id: "alarm_clear",
      label: "Signal stack confirms amber-to-green",
      tStart: wipeEnd + verifyDur,
      tEnd: tEnd,
      cameraHint: "side-a",
      motion: {
        pose: "stand",
        standAt: verify,
        look: toWorld(env, [-4.6, 2.5, -4.3]), // world signal stack
      },
    },
  ];

  const b = SENSOR_TRIP_BANK;
  const narration = [
    { t: 2, text: rng.pick(b.open) },
    { t: failSec + 1, text: rng.pick(b.locate) },
    { t: failSec + 7, text: rng.pick(b.found) },
    { t: wipeEnd - wipeDur / 2, text: rng.pick(b.wipe) },
    { t: clearAt + 1, text: rng.pick(b.verify) },
    { t: Math.max(greenAt + 2, tEnd - 6), text: rng.pick(b.clear) },
  ];

  const cell: ScenarioCell = {
    dust: { appearsAt: failSec, clearedAt: clearAt },
    wayLube: null,
    atc: null,
    signals: [
      { tStart: 0, red: 1, amber: 0, green: 0 },
      { tStart: clearAt, red: 0, amber: 1, green: 0 },
      { tStart: greenAt, red: 0, amber: 0, green: 1 },
    ],
  };

  return {
    id: slot === 0 ? `${templateId}-${env.id}` : `${templateId}-${env.id}-${slot}`,
    templateId,
    slot,
    title: "False overtravel alarm: dust-bridged guard-door sensor",
    role: "CNC machinist troubleshooting a false X-axis overtravel alarm",
    durationSec: tEnd,
    fps: 30,
    cameras: ["side-a", "side-b", "head", "chest"],
    beats,
    narration,
    lesson: {
      title: rng.pick(b.lessonTitles),
      body: rng.pick(b.lessonBodies),
    },
    cell,
    faultWorld,
  };
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
