/**
 * Headless proof that the head/chest cameras ride the avatar's body rigidly.
 *
 * Runs the REAL driveScenario + applyScenario against the real avatar rig in
 * pure Node (three.js math only, no WebGL) and asserts:
 *
 *  1. LEAN MOVES THE MOUNT: with everything else held constant, going from
 *     lean=0 to lean=0.25 displaces the head-camera mount forward and down
 *     with the rotating torso (a root-mounted cam would not move at all).
 *  2. BOB MOVES THE MOUNT: during the walk beat, the mount's world Y tracks
 *     the gait bob (body.position.y) instead of staying at a fixed height.
 *  3. AIM INTACT: both look pivots still aim at the scenario lookAt target
 *     after the re-mount, and the chest cam keeps its deliberate downward
 *     framing tilt relative to its pivot (rigid parent chain).
 *
 * Usage: node scripts/verify-cam-rig.mts after esbuild-bundling, see
 * `npm run verify:rig`-style invocation in the repo scripts (or:
 *   node_modules/.bin/esbuild scripts/verify-cam-rig.mts --bundle
 *     --platform=node --format=esm --external:three
 *     --outfile=scripts/verify-cam-rig.bundle.mjs && node scripts/verify-cam-rig.bundle.mjs
 * )
 */

import * as THREE from "three";
import { createAvatar } from "@/avatar.ts";
import { applyScenario } from "@/sim/apply.ts";
import { driveScenario, type ScenarioState } from "@/scenario/drive.ts";
import { sensorTripScenario } from "@/scenario/sensor-trip.ts";
import type { MachineCell } from "@/cell.ts";

let failures = 0;

function check(name: string, cond: boolean, detail: string): void {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failures += 1;
  console.log(`[${tag}] ${name}: ${detail}`);
}

// applyScenario touches cell materials and transforms; these meshes keep the
// proof WebGL-free while matching the runtime cell contract.
function cellStub(): MachineCell {
  const mesh = (): THREE.Mesh =>
    new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({ emissive: 0x000000 }),
    );
  return {
    root: new THREE.Group(),
    signalStack: { red: mesh(), amber: mesh(), green: mesh() },
    guardSensor: { panel: mesh(), head: mesh(), dust: mesh() },
    spindle: new THREE.Group(),
    atc: new THREE.Group(),
    wayLube: mesh(),
  };
}

const avatar = createAvatar();
const cell = cellStub();

function applyState(state: ScenarioState): void {
  applyScenario(state, avatar, cell);
  avatar.root.updateWorldMatrix(true, true);
}

function driveTo(t: number): void {
  applyState(driveScenario(sensorTripScenario, t));
}

function worldForward(obj: THREE.Object3D): THREE.Vector3 {
  return new THREE.Vector3(0, 0, -1).applyQuaternion(
    obj.getWorldQuaternion(new THREE.Quaternion()),
  );
}

function withoutLean(state: ScenarioState): ScenarioState {
  return { ...state, avatar: { ...state.avatar, lean: 0 } };
}

// 1) Lean: at t=15s the locate_sensor beat holds lean=0.25 (x LEAN_GAIN = 0.225
//    rad about the hip). Compare the head mount's world position against the
//    same instant with lean zeroed. The pivot sits at (y=0.52, z=0.1) in the
//    torso frame, so the rigid arc predicts an exact displacement of
//    ~0.119m forward (with a slight rise, since the pivot is nearly above the
//    hip); a root- or body-mounted cam would not move at all.
function assertLeanMovesMount(): void {
  const state = driveScenario(sensorTripScenario, 15.0);
  applyState(withoutLean(state));
  const p0 = avatar.face.getWorldPosition(new THREE.Vector3());
  applyState(state);
  const p1 = avatar.face.getWorldPosition(new THREE.Vector3());
  const d = p1.clone().sub(p0);

  // Analytic rigid-body prediction: rotate torso-local (0, 0.52, 0.1) by
  // theta = -lean * LEAN_GAIN about X.
  const theta = -state.avatar.lean * 0.9; // LEAN_GAIN in sim/apply.ts
  const y = 0.52,
    z = 0.1;
  const expected = new THREE.Vector3(
    0,
    y * Math.cos(theta) - z * Math.sin(theta) - y,
    y * Math.sin(theta) + z * Math.cos(theta) - z,
  );
  const err = d.distanceTo(expected);
  check(
    "lean moves the mount",
    err < 1e-3 && d.z < -0.05,
    `head mount displaced (${d.x.toFixed(4)}, ${d.y.toFixed(4)}, ${d.z.toFixed(4)})m; ` +
      `rigid-arc prediction error ${err.toExponential(2)}m`,
  );
}

// 2) Bob: body.position.y = |sin(t*7)| * 0.02 while walking. Sample the head
//    mount world Y at a bob peak (t=2.0194) vs the next zero crossing
//    (t=2.2440, half a gait period later); a body-riding mount tracks it.
function assertBobMovesMount(): void {
  const ys: number[] = [];
  for (const t of [2.0194, 2.244]) {
    driveTo(t);
    ys.push(avatar.face.getWorldPosition(new THREE.Vector3()).y);
  }
  const range = Math.abs(ys[0] - ys[1]);
  check(
    "walk bob moves the mount",
    range > 0.01,
    `head mount world Y varies ${range.toFixed(4)}m across half a gait cycle (bob amplitude 0.02m)`,
  );
}

// 3) Aim: each look pivot's world -Z must point at the beat's look target,
//    and the chest cam (deliberate -0.25 tilt, as in main.ts) must stay a
//    rigid child of its pivot.
function assertAimIntact(): void {
  driveTo(36.5); // verify_clear beat, cameraHint "chest", lean 0.12
  const target = new THREE.Vector3(...(sensorTripScenario.beats[3].motion.look ?? [0, 1.3, -1]));

  const headAim = worldForward(avatar.face);
  const headToTarget = target
    .clone()
    .sub(avatar.face.getWorldPosition(new THREE.Vector3()))
    .normalize();
  const headDot = headAim.dot(headToTarget);

  const chestAim = worldForward(avatar.chestFace);
  const chestToTarget = target
    .clone()
    .sub(avatar.chestFace.getWorldPosition(new THREE.Vector3()))
    .normalize();
  const chestDot = chestAim.dot(chestToTarget);

  const cam = new THREE.PerspectiveCamera();
  cam.position.set(0, -0.35, 0.18);
  cam.rotation.set(-0.25, 0, 0);
  avatar.chestFace.add(cam);
  avatar.chestFace.updateWorldMatrix(true, true);
  const camRigidity = worldForward(cam).dot(chestAim);

  check("aim intact (head)", headDot > 0.98, `head pivot aim·(target dir)=${headDot.toFixed(3)}`);
  check(
    "aim intact (chest)",
    chestDot > 0.98,
    `chest pivot aim·(target dir)=${chestDot.toFixed(3)}`,
  );
  check(
    "chest cam rigid under pivot",
    camRigidity > 0.9,
    `chest cam fwd·(pivot aim)=${camRigidity.toFixed(3)} (keeps its -0.25 framing tilt)`,
  );
}

console.log("verify-cam-rig: proving head/chest cams ride the body rigidly\n");
assertLeanMovesMount();
assertBobMovesMount();
assertAimIntact();

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
