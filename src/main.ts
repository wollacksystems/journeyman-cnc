import * as THREE from "three";
import "./style.css";
import { FrameClock } from "./clock";
import { createAvatar, type Avatar } from "./avatar";
import { createMachineCell, type MachineCell } from "./cell";
import { CameraRig, VIEWPORT_GRID, type CameraId } from "./rig";
import { startInspectorHub } from "./inspector";
import { sensorTripScenario } from "./scenario/sensor-trip";
import { validateScenario } from "./scenario/types";
import { driveScenario } from "./scenario/drive";
import { applyScenario } from "./sim/apply";
import { captureBatch, downloadBlob, CAPTURE_HEIGHT, CAPTURE_WIDTH } from "./capture/batch";
import { recordComposite } from "./capture/composite";
import { buildCaptureManifest } from "./manifest";

const FPS = 30;

// Phase 2 drives the first scenario end to end; later phases swap in more
// definitions from a scenario registry.
const scenario = sensorTripScenario;
const scenarioProblems = validateScenario(scenario);
if (scenarioProblems.length > 0) {
  throw new Error(`Scenario validation failed: ${scenarioProblems.join("; ")}`);
}

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

// Mount the first-person cameras under the torso-mounted look pivots so they
// ride torso lean and gait bob rigidly (mounts move with the body) and keep
// tracking the scenario look target. The body still hides per viewport, so
// those cams never see their own model.
const headCam = viewportById("head");
headCam.position.set(0, 0.02, 0.12);
headCam.rotation.set(0, 0, 0);
const chestCam = viewportById("chest");
chestCam.position.set(0, -0.35, 0.18);
chestCam.rotation.set(-0.25, 0, 0);
avatar.face.add(headCam);
avatar.chestFace.add(chestCam);

const inspectorHub = startInspectorHub();
const snapshotViewports = rig.viewports.map((v) => ({ id: v.id, label: v.label }));
const clock = new FrameClock(FPS);

// The first-person mounts ride the body (lean + bob) and the look pivots
// aim them, so the rig feeds read like wearable cameras on a moving torso.

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  rig.setAspect(w, h);
}
window.addEventListener("resize", resize);
resize();

function frameLoop(): void {
  const state = clock.tick();
  if (state) {
    applyScenario(driveScenario(scenario, state.t), avatar, cell);
    rig.update(state.t, avatar.root);
    inspectorHub.publish({
      frame: state.frame,
      t: state.t,
      fps: clock.fps,
      viewports: snapshotViewports,
    });
  }
  rig.renderAll(renderer, scene, avatar.body);
}
renderer.setAnimationLoop(frameLoop);

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

  // Capture toolbar: real-time composite + deterministic MP4 corpus.
  const status = document.createElement("div");
  status.id = "capture-status";
  status.textContent = "idle";
  document.body.appendChild(status);

  const toolbar = document.createElement("div");
  toolbar.id = "capture-toolbar";

  const recBtn = document.createElement("button");
  recBtn.textContent = "REC COMPOSITE";
  recBtn.addEventListener("click", () => {
    void compositeFlow();
  });

  const corpusBtn = document.createElement("button");
  corpusBtn.textContent = "RENDER CORPUS";
  corpusBtn.addEventListener("click", () => {
    void batchFlow();
  });

  toolbar.append(recBtn, corpusBtn);
  document.body.appendChild(toolbar);

  let busy = false;
  const setBusy = (value: boolean): void => {
    busy = value;
    recBtn.disabled = value;
    corpusBtn.disabled = value;
  };
  const statusFor = (text: string): void => {
    status.textContent = text;
  };

  async function compositeFlow(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      clock.reset(); // wall-clock composite runs a fresh 0..duration loop
      statusFor("recording composite...");
      const blob = await recordComposite(renderer, scenario.durationSec, FPS, (t) => {
        statusFor(`recording composite ${t.toFixed(1)}s`);
      });
      downloadBlob(blob, `renders/${scenario.id}/composite.webm`);
      statusFor(`saved renders/${scenario.id}/composite.webm`);
    } catch (error) {
      console.error(error);
      statusFor(`composite failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function batchFlow(): Promise<void> {
    if (busy) return;
    setBusy(true);
    renderer.setAnimationLoop(null); // batch drives its own frames; don't compete with the live canvas
    try {
      const totalFrames = Math.round(scenario.durationSec * scenario.fps);
      statusFor(
        `encoding ${scenario.cameras.length} cameras x ${totalFrames} frames (${CAPTURE_WIDTH}x${CAPTURE_HEIGHT})`,
      );
      const startedUtc = new Date().toISOString();
      const result = await captureBatch({
        scenario,
        rig,
        scene,
        avatar,
        cell,
        onProgress: (p) => {
          statusFor(
            `${p.camera} ${p.frame}/${p.totalFrames} (camera ${p.cameraIndex + 1}/${p.cameraTotal})`,
          );
        },
      });
      for (const clip of result.clips) {
        downloadBlob(clip.blob, `renders/${scenario.id}/${clip.camera}.mp4`);
      }
      const manifest = buildCaptureManifest(
        scenario,
        rig,
        CAPTURE_WIDTH,
        CAPTURE_HEIGHT,
        startedUtc,
      );
      downloadBlob(
        new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }),
        `renders/${scenario.id}/manifest.json`,
      );
      statusFor(`saved renders/${scenario.id}/: ${result.clips.length} clips + manifest`);
    } catch (error) {
      console.error(error);
      statusFor(`batch failed: ${String(error)}`);
    } finally {
      renderer.setAnimationLoop(frameLoop);
      setBusy(false);
    }
  }
}
