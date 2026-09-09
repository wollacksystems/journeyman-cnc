import * as THREE from "three";

/**
 * CNC cell built from primitives: floor, enclosure walls, a VMC-style machine
 * (column, saddle, spindle head), a worktable, a safety-light indicator stack,
 * and a guard-door proximity/interlock sensor the scenarios drive. No physics
 * - everything is kinematic.
 */
export interface MachineCell {
  root: THREE.Group;
  /** Red/amber/green indicator stack on the enclosure. */
  signalStack: { red: THREE.Mesh; amber: THREE.Mesh; green: THREE.Mesh };
  /** Spindle head the tool hangs from (animated in later phases). */
  spindle: THREE.Group;
  /** Tool changer pod (ATC) the jam scenario targets. */
  atc: THREE.Group;
  /** Guard door panel + wafer-style proximity sensor the sensor-trip scenario targets. */
  guardSensor: {
    panel: THREE.Mesh;
    head: THREE.Mesh;
    /** Dust blob around the sensor face (visible/proportional to contamination). */
    dust: THREE.Mesh;
  };
}

const steel = new THREE.MeshStandardMaterial({ color: 0x6b7280, roughness: 0.55, metalness: 0.35 });
const darkSteel = new THREE.MeshStandardMaterial({
  color: 0x374151,
  roughness: 0.6,
  metalness: 0.4,
});
const tableMat = new THREE.MeshStandardMaterial({
  color: 0x9ca3af,
  roughness: 0.4,
  metalness: 0.55,
});

function box(
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function cyl(
  rTop: number,
  rBottom: number,
  h: number,
  mat: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, 24), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

export function createMachineCell(): MachineCell {
  const root = new THREE.Group();
  root.name = "machine-cell";

  // Floor.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.95 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  // Enclosure walls (back + two sides, low front so cameras see in).
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x3f4754, roughness: 0.9 });
  const backWall = box(12, 3.4, 0.2, wallMat, 0, 1.7, -4.5);
  const leftWall = box(0.2, 3.4, 9, wallMat, -6, 1.7, 0);
  const rightWall = box(0.2, 3.4, 9, wallMat, 6, 1.7, 0);
  root.add(backWall, leftWall, rightWall);

  // Machine: base, column, saddle, spindle head.
  const machine = new THREE.Group();
  machine.name = "vmc";
  machine.position.set(0, 0, -1.6);

  const base = box(3.2, 0.5, 2.4, darkSteel, 0, 0.25, 0);
  const column = box(2.6, 2.4, 0.7, steel, 0, 1.7, -0.85);
  const saddle = box(2.2, 0.28, 1.6, steel, 0, 0.85, 0.2);
  const headstock = box(1.1, 0.6, 1.0, darkSteel, 0, 2.35, 0.35);

  const spindle = new THREE.Group();
  spindle.name = "spindle";
  spindle.position.set(0, 2.05, 0.55);
  const spindleNose = cyl(0.09, 0.09, 0.42, darkSteel, 0, 0, 0);
  const tool = cyl(0.012, 0.012, 0.3, tableMat, 0, -0.33, 0);
  spindle.add(spindleNose, tool);

  machine.add(base, column, saddle, headstock, spindle);

  // Worktable with a raw stock block (the part being machined).
  const table = box(1.8, 0.12, 1.2, tableMat, 0, 1.02, 0.2);
  const stock = box(
    0.5,
    0.3,
    0.5,
    new THREE.MeshStandardMaterial({ color: 0xb5915a, roughness: 0.65, metalness: 0.2 }),
    0,
    1.23,
    0.2,
  );
  machine.add(table, stock);

  // ATC pod: umbrella-style tool carousel beside the column.
  const atc = new THREE.Group();
  atc.name = "atc";
  atc.position.set(2.1, 0, -1.0);
  const atcBase = cyl(0.5, 0.6, 0.9, darkSteel, 0, 0.45, 0);
  const atcDisc = cyl(0.55, 0.55, 0.12, steel, 0, 1.05, 0);
  atc.add(atcBase, atcDisc);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const pocket = cyl(0.03, 0.03, 0.35, tableMat, Math.cos(a) * 0.42, 1.28, Math.sin(a) * 0.42);
    atc.add(pocket);
  }

  // Guard door panel with a proximity/interlock sensor on the machine front
  // (local z 0 ~ world z 0 range, waist high so the expert can wipe it).
  const guardPanel = box(0.06, 1.8, 1.1, steel, 0.35, 0.9, 1.6);
  const guardFrame = box(0.26, 1.8, 0.08, darkSteel, 0.47, 0.9, 1.34);
  machine.add(guardPanel, guardFrame);

  const sensorHead = cyl(0.035, 0.035, 0.09, darkSteel, 0.35, 1.06, 1.83);
  const sensorFace = cyl(
    0.028,
    0.028,
    0.012,
    new THREE.MeshStandardMaterial({ color: 0x1f2430, emissive: 0x000000 }),
    0.35,
    1.06,
    1.883,
  );
  const dust = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 16, 12),
    new THREE.MeshBasicMaterial({
      color: 0x9aa4b0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }),
  );
  dust.position.set(0.35, 1.06, 1.945);
  dust.name = "sensor-dust";
  machine.add(sensorHead, sensorFace, dust);

  // Signal stack on the enclosure wall (scenario-driven).
  const signalStack = {
    red: cyl(
      0.06,
      0.06,
      0.16,
      new THREE.MeshStandardMaterial({ color: 0x7f1d1d, emissive: 0x000000 }),
      -4.6,
      2.6,
      -4.3,
    ),
    amber: cyl(
      0.06,
      0.06,
      0.16,
      new THREE.MeshStandardMaterial({ color: 0x92400e, emissive: 0x000000 }),
      -4.6,
      2.42,
      -4.3,
    ),
    green: cyl(
      0.06,
      0.06,
      0.16,
      new THREE.MeshStandardMaterial({ color: 0x14532d, emissive: 0x000000 }),
      -4.6,
      2.24,
      -4.3,
    ),
  };

  root.add(machine, atc, signalStack.red, signalStack.amber, signalStack.green);

  return {
    root,
    signalStack,
    spindle,
    atc,
    guardSensor: { panel: guardPanel, head: sensorFace, dust },
  };
}

/** Set the indicator stack lights (0..1 intensity each). */
export function setSignalLights(
  stack: MachineCell["signalStack"],
  red: number,
  amber: number,
  green: number,
): void {
  const apply = (mesh: THREE.Mesh, intensity: number, base: number, lit: number) => {
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.emissive.setHex(intensity > 0 ? lit : 0x000000);
    mat.emissiveIntensity = intensity;
    mat.color.setHex(intensity > 0 ? lit : base);
  };
  apply(stack.red, red, 0x7f1d1d, 0xff2020);
  apply(stack.amber, amber, 0x92400e, 0xffb020);
  apply(stack.green, green, 0x14532d, 0x30ff50);
}

/** Drive the guard-door sensor dust 0..1 (0 = clean/wiped). */
export function setSensorDust(cell: MachineCell, amount: number): void {
  const dust = cell.guardSensor.dust;
  const clamped = Math.max(0, Math.min(1, amount));
  dust.visible = clamped > 0.02;
  const mat = dust.material as THREE.MeshBasicMaterial;
  mat.opacity = clamped;
  const s = 0.5 + clamped * 0.9;
  dust.scale.set(s, s, s);
  (cell.guardSensor.head.material as THREE.MeshStandardMaterial).emissiveIntensity = clamped * 2;
}
