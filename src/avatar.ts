import * as THREE from "three";

/**
 * Primitive-first avatar: capsule torso, box head, cylinder limbs.
 * The body group is hidden per-camera by the rig on first-person viewports
 * (see CameraRig.renderCamera / renderAll); first-person cameras mount to
 * `face`/`chestFace` under the body pivots, so they ride torso lean and gait
 * bob rigidly while still inheriting the look-target aim.
 *
 * Arms are two-bone chains (shoulder -> elbow -> hand) solved with analytic
 * inverse kinematics so scenarios can reach/hand targets deterministically
 * from a world-space point.
 */

export const ARM_UPPER = 0.35;
export const ARM_FOREARM = 0.34;

export interface Arm {
  root: THREE.Group;
  elbow: THREE.Group;
  /** Orient the chain so the hand reaches the given world-space point. */
  ik(targetWorld: THREE.Vector3): void;
  /** Return the arm to its hanging rest pose. */
  rest(): void;
}

export interface Avatar {
  root: THREE.Group;
  /** Body meshes (hidden from first-person cameras by the rig). */
  body: THREE.Group;
  /** Torso pivot at hip height; forward lean rotates this group. */
  torso: THREE.Group;
  /** Body-mounted camera pivots (children of torso) that ride lean + bob rigidly. */
  headPivot: THREE.Object3D;
  chestPivot: THREE.Object3D;
  /** Look pivots under each body pivot; cams mount here so lookAt aims them. */
  face: THREE.Object3D;
  chestFace: THREE.Object3D;
  arms: { left: Arm; right: Arm };
}

const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x4a7fb5, roughness: 0.7 });
const armMaterial = new THREE.MeshStandardMaterial({ color: 0x3f6da0, roughness: 0.65 });
const accentMaterial = new THREE.MeshStandardMaterial({ color: 0xd8dee6, roughness: 0.5 });

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = true;
  return m;
}

function hangingCylinder(
  geo: THREE.CylinderGeometry,
  material: THREE.Material,
  length: number,
): THREE.Mesh {
  geo.translate(0, -length / 2, 0);
  return mesh(geo, material);
}

function armChain(torso: THREE.Object3D, side: 1 | -1): Arm {
  const root = new THREE.Group();
  root.name = side === 1 ? "arm-left" : "arm-right";

  const upper = hangingCylinder(
    new THREE.CylinderGeometry(0.055, 0.05, ARM_UPPER, 12),
    armMaterial,
    ARM_UPPER,
  );
  root.add(upper);

  const elbow = new THREE.Group();
  elbow.name = "elbow";
  elbow.position.set(0, -ARM_UPPER, 0);
  const forearm = hangingCylinder(
    new THREE.CylinderGeometry(0.045, 0.04, ARM_FOREARM, 12),
    armMaterial,
    ARM_FOREARM,
  );
  elbow.add(forearm);

  const hand = mesh(new THREE.SphereGeometry(0.055, 12, 10), accentMaterial);
  hand.position.set(0, -ARM_FOREARM, 0);
  elbow.add(hand);

  root.add(elbow);

  const restRotation = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(0.1, 0, side === 1 ? 0.22 : -0.22),
  );
  const restBend = 0.14;

  const solve = (targetLocal: THREE.Vector3): void => {
    const L1 = ARM_UPPER;
    const L2 = ARM_FOREARM;
    const shoulder = root.position; // target is expressed in the torso frame
    const d = targetLocal.clone().sub(shoulder);
    const dist = d.length();
    const clamped = Math.min(dist, L1 + L2 - 0.02);

    const up = new THREE.Vector3(0, 1, 0);
    const along = d.clone().normalize();

    let cosThetaS = 1;
    let bend = 0;
    if (clamped > 1e-5) {
      cosThetaS = Math.max(
        -1,
        Math.min(1, (L1 * L1 + clamped * clamped - L2 * L2) / (2 * L1 * clamped)),
      );
      const cosBend = Math.max(
        -1,
        Math.min(1, (L1 * L1 + L2 * L2 - clamped * clamped) / (2 * L1 * L2)),
      );
      bend = Math.PI - Math.acos(cosBend);
    }
    const thetaS = Math.acos(cosThetaS);

    const n = new THREE.Vector3().crossVectors(up, along);
    if (n.lengthSq() < 1e-8) n.set(1, 0, 0);
    n.normalize();

    const upPerp = new THREE.Vector3().copy(up).addScaledVector(along, -up.dot(along)).normalize();
    const chainDir = new THREE.Vector3()
      .copy(along)
      .multiplyScalar(Math.cos(thetaS))
      .addScaledVector(upPerp, Math.sin(thetaS));

    // Basis for the shoulder so that the chain's local -Y lands on chainDir
    // and the elbow flexes about the bend-plane normal.
    const x = n;
    const y = chainDir.clone().negate();
    const z = new THREE.Vector3().crossVectors(x, y).normalize();
    root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    elbow.rotation.x = bend;
  };

  return {
    root,
    elbow,
    ik(targetWorld: THREE.Vector3): void {
      torso.updateWorldMatrix(true, false);
      solve(torso.worldToLocal(targetWorld.clone()));
    },
    rest(): void {
      root.quaternion.copy(restRotation);
      elbow.rotation.x = restBend;
    },
  };
}

export function createAvatar(): Avatar {
  const root = new THREE.Group();
  root.name = "avatar";

  const body = new THREE.Group();
  body.name = "avatar-body";

  // Torso pivot at hip height; lean rotates this group (legs stay vertical).
  const torso = new THREE.Group();
  torso.name = "avatar-torso";
  torso.position.set(0, 1.1, 0);

  const torsoMesh = mesh(new THREE.CapsuleGeometry(0.22, 0.55, 8, 16), bodyMaterial);
  torsoMesh.position.y = 0.02;
  torso.add(torsoMesh);

  const head = mesh(new THREE.BoxGeometry(0.26, 0.3, 0.26), accentMaterial);
  head.position.y = 0.56;
  torso.add(head);

  const left = armChain(torso, 1);
  left.root.position.set(-0.32, 0.24, 0);
  const right = armChain(torso, -1);
  right.root.position.set(0.34, 0.24, 0);
  torso.add(left.root, right.root);

  // Legs: cylinders, kept on the body (not the torso pivot) so they stay
  // planted while the torso leans.
  const legGeo = new THREE.CylinderGeometry(0.09, 0.07, 0.85, 12);
  const legL = mesh(legGeo, bodyMaterial);
  legL.position.set(-0.13, 0.42, 0);
  const legR = mesh(legGeo, bodyMaterial);
  legR.position.set(0.13, 0.42, 0);

  body.add(torso, legL, legR);
  root.add(body);

  // Body-mounted camera pivots hang off the torso pivot (not body) so both
  // torso lean and the body's gait sway/bob move the mounts rigidly.
  const headPivot = new THREE.Object3D();
  headPivot.name = "avatar-head";
  headPivot.position.set(0, 0.52, 0);
  torso.add(headPivot);

  const chestPivot = new THREE.Object3D();
  chestPivot.name = "avatar-chest";
  chestPivot.position.set(0, 0.11, 0);
  torso.add(chestPivot);

  // Look pivots: first-person cams mount here so they ride lean/bob through
  // the body pivots above and track the look target via lookAt.
  const face = new THREE.Object3D();
  face.name = "avatar-face";
  face.position.set(0, 0, 0.1);
  headPivot.add(face);
  const chestFace = new THREE.Object3D();
  chestFace.name = "avatar-face-chest";
  chestFace.position.set(0, 0, 0.1);
  chestPivot.add(chestFace);

  left.rest();
  right.rest();

  return { root, body, torso, face, chestFace, headPivot, chestPivot, arms: { left, right } };
}
