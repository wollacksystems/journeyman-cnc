import * as THREE from "three";
import type { Avatar } from "../avatar";
import type { MachineCell } from "../cell";
import { setAtcState, setSensorDust, setSignalLights, setWayLube } from "../cell";
import type { ScenarioState } from "../scenario/drive";

const WALK_CYCLE = 7;
const LEAN_GAIN = 0.9;

/**
 * Apply a deterministic scenario state to the live Three.js objects.
 * Everything here is a pure function of `state`: the same state always yields
 * the same scene, which is what keeps interactive and batch renders identical.
 */
export function applyScenario(state: ScenarioState, avatar: Avatar, cell: MachineCell): void {
  const t = state.t;

  // Root position (avatar model faces local -Z, toward the machine).
  avatar.root.position.set(state.avatar.position[0], 0, state.avatar.position[1]);

  // Gait sway + bob while walking.
  const walking = state.avatar.walking;
  const swing = Math.sin(t * WALK_CYCLE);
  avatar.body.rotation.x = walking ? swing * 0.03 : 0;
  avatar.body.position.y = walking ? Math.abs(swing) * 0.02 : 0;

  // Torso lean (positive lean = forward, toward -Z).
  avatar.torso.rotation.x = -state.avatar.lean * LEAN_GAIN;

  // Aim both look pivots at the scenario target. The first-person cams mount
  // under these pivots, so each cam rides its body pivot (lean + bob) and
  // inherits the look aim in one transform chain — no world-plumb divergence.
  avatar.face.lookAt(new THREE.Vector3(...state.avatar.lookAt));
  avatar.face.rotateY(Math.PI);
  avatar.chestFace.lookAt(new THREE.Vector3(...state.avatar.lookAt));
  avatar.chestFace.rotateY(Math.PI);

  // Arms: the active reach hand solves IK to its target, the other hangs.
  const reach = state.avatar.reach;
  if (reach) {
    const activeArm = reach.hand === "left" ? avatar.arms.left : avatar.arms.right;
    const idleArm = reach.hand === "left" ? avatar.arms.right : avatar.arms.left;
    activeArm.ik(new THREE.Vector3(...reach.target));
    idleArm.rest();
  } else {
    avatar.arms.left.rest();
    avatar.arms.right.rest();
  }

  // Cell state.
  setSensorDust(cell, state.cell.dust);
  setWayLube(cell, state.cell.wayLube);
  setAtcState(cell, state.cell.atcJammed, state.cell.atcRotation);
  setSignalLights(
    cell.signalStack,
    state.cell.signal.red,
    state.cell.signal.amber,
    state.cell.signal.green,
  );
  cell.spindle.rotation.y = t * 0.6;
}
