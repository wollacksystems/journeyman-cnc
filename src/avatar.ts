import * as THREE from "three";

/**
 * Primitive-first avatar: capsule torso, box head, cylinder limbs.
 * The body group is hidden per-camera by the rig on first-person viewports
 * (see CameraRig.renderAll); cameras mount to `face`, which tracks root
 * orientation without inheriting body visibility.
 */
export interface Avatar {
  root: THREE.Group;
  /** Body meshes (hidden from first-person cameras by the rig). */
  body: THREE.Group;
  /** Forward-facing camera mount pivot. */
  face: THREE.Object3D;
}

const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x4a7fb5, roughness: 0.7 });
const accentMaterial = new THREE.MeshStandardMaterial({ color: 0xd8dee6, roughness: 0.5 });

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = true;
  return m;
}

export function createAvatar(): Avatar {
  const root = new THREE.Group();
  root.name = "avatar";

  const body = new THREE.Group();
  body.name = "avatar-body";

  // Torso: capsule.
  const torso = mesh(new THREE.CapsuleGeometry(0.22, 0.55, 8, 16), bodyMaterial);
  torso.position.y = 1.15;

  // Head: box.
  const head = mesh(new THREE.BoxGeometry(0.26, 0.3, 0.26), accentMaterial);
  head.position.y = 1.66;

  // Arms: cylinders hanging at the sides.
  const armGeo = new THREE.CylinderGeometry(0.06, 0.05, 0.6, 12);
  const armL = mesh(armGeo, bodyMaterial);
  armL.position.set(-0.32, 1.2, 0);
  armL.rotation.z = 0.12;
  const armR = mesh(armGeo, bodyMaterial);
  armR.position.set(0.32, 1.2, 0);
  armR.rotation.z = -0.12;

  // Legs: cylinders.
  const legGeo = new THREE.CylinderGeometry(0.09, 0.07, 0.85, 12);
  const legL = mesh(legGeo, bodyMaterial);
  legL.position.set(-0.13, 0.42, 0);
  const legR = mesh(legGeo, bodyMaterial);
  legR.position.set(0.13, 0.42, 0);

  body.add(torso, head, armL, armR, legL, legR);
  root.add(body);

  // Face pivot: first-person camera mount (head/chest cams are added here by
  // main.ts).
  const face = new THREE.Object3D();
  face.name = "avatar-face";
  face.position.set(0, 1.6, 0);
  root.add(face);

  return { root, body, face };
}
