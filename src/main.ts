import * as THREE from "three";
import "./style.css";
import { FrameClock } from "./clock";
import { createAvatar, type Avatar } from "./avatar";
import { createMachineCell, setSignalLights, type MachineCell } from "./cell";
import { CameraRig, VIEWPORT_GRID, type CameraId } from "./rig";
import { startInspectorHub } from "./inspector";

const FPS = 30;

// Scripted beats (Phase 3 will replace these with a scenario script):
// 0–4s idle at the cell entrance, 4–12s walk up to the machine.
const WALK_START = 4;
const WALK_END = 12;
const WALK_FROM_Z = 3.2;
const WALK_TO_Z = 1.35;

const canvas = document.querySelector<HTMLCanvasElement>("#rig");
if (!canvas) throw new Error("#rig canvas missing");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11141a);
scene.fog = new THREE.Fog(0x11141a, 14, 32);

// Neutral key + fill lighting; revisit in the Phase 5 polish pass (PBR/HDRI).
scene.add(new THREE.HemisphereLight(0x8fa3bf, 0x2b2f36, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(4, 8, 3);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.left = -8;
key.shadow.camera.right = 8;
key.shadow.camera.top = 8;
key.shadow.camera.bottom = -8;
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 24;
scene.add(key);
const fill = new THREE.DirectionalLight(0x9db4d0, 0.5);
fill.position.set(-5, 6, -4);
scene.add(fill);

const cell: MachineCell = createMachineCell();
scene.add(cell.root);

const avatar: Avatar = createAvatar();
scene.add(avatar.root);

// Reference grid for the debug cams.
const grid = new THREE.GridHelper(24, 48, 0x3a4150, 0x242a33);
grid.position.y = 0.002;
scene.add(grid);

const rig = new CameraRig();

const viewportById = (id: CameraId): THREE.PerspectiveCamera => {
  const vp = rig.viewports.find((v) => v.id === id);
  if (!vp) throw new Error(`viewport ${id} missing`);
  return vp.camera;
};

// Mount the first-person cameras on the avatar's face pivot; the rig hides
// the body meshes per viewport, so they never occlude their own view.
const headCam = viewportById("head");
headCam.position.set(0, 0.02, 0.12);
headCam.rotation.set(0, 0, 0);
const chestCam = viewportById("chest");
chestCam.position.set(0, -0.35, 0.18);
chestCam.rotation.set(-0.25, 0, 0);
avatar.face.add(headCam, chestCam);

/** Scripted walk position — a pure function of simulation time. */
function walkZ(t: number): number {
  if (t <= WALK_START) return WALK_FROM_Z;
  if (t >= WALK_END) return WALK_TO_Z;
  const k = (t - WALK_START) / (WALK_END - WALK_START);
  const e = k * k * (3 - 2 * k); // smoothstep
  return WALK_FROM_Z + (WALK_TO_Z - WALK_FROM_Z) * e;
}

function updateAvatar(t: number): void {
  avatar.root.position.set(0, 0, walkZ(t));
  avatar.face.rotation.y = 0; // cameras look down local -Z = world -Z, toward the machine
  const walking = t > WALK_START && t < WALK_END;
  avatar.body.rotation.x = walking ? Math.sin(t * 7) * 0.03 : 0;
  avatar.body.position.y = walking ? Math.abs(Math.sin(t * 7)) * 0.02 : 0;
}

function updateCell(t: number): void {
  cell.spindle.rotation.y = t * 0.6;
  const walking = t > WALK_START && t < WALK_END;
  setSignalLights(
    cell.signalStack,
    0,
    walking ? 0.5 + 0.5 * Math.sin(t * Math.PI * 2) : 0,
    walking ? 0 : 0.85,
  );
}

const inspectorHub = startInspectorHub();
const snapshotViewports = rig.viewports.map((v) => ({ id: v.id, label: v.label }));
const clock = new FrameClock(FPS);

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  rig.setAspect(w, h);
}
window.addEventListener("resize", resize);
resize();

if (import.meta.env.DEV) {
  // Composite overlay labels matching the 3x2 viewport grid.
  const labels = document.createElement("div");
  labels.id = "labels";
  for (const vp of rig.viewports) {
    const el = document.createElement("span");
    el.className = "vp-label";
    el.textContent = vp.label;
    el.style.left = `${(vp.cell[0] * 100) / VIEWPORT_GRID.cols}%`;
    el.style.top = `${(vp.cell[1] * 100) / VIEWPORT_GRID.rows}%`;
    labels.appendChild(el);
  }
  document.body.appendChild(labels);

  const openBtn = document.createElement("button");
  openBtn.id = "open-inspector";
  openBtn.textContent = "OPEN INSPECTOR";
  openBtn.addEventListener("click", () => {
    window.open(
      import.meta.env.BASE_URL + "inspector.html",
      "journeyman-sim-inspector",
      "width=440,height=340",
    );
  });
  document.body.appendChild(openBtn);
}

renderer.setAnimationLoop(() => {
  const state = clock.tick();
  if (state) {
    updateAvatar(state.t);
    updateCell(state.t);
    rig.update(state.t, avatar.root);
    inspectorHub.publish({
      frame: state.frame,
      t: state.t,
      fps: clock.fps,
      viewports: snapshotViewports,
    });
  }
  rig.renderAll(renderer, scene, avatar.body);
});
