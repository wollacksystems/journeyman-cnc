import * as THREE from "three";
import { createAvatar, type Avatar } from "../avatar";
import type { CameraRig } from "../rig";
import { createMachineCell, type MachineCell } from "../cell";
import { toWorldXZ, type EnvSpec } from "./environment";

/**
 * Static side-camera anchors, authored in the machine frame like every other
 * scene element. world.setEnv rotates them with the environment yaw so the
 * "static" side shots always frame the cell's operator zone (static in the
 * machine frame, not a fixed point of the world).
 */
export const SIDE_CAM_ANCHOR_A: readonly [number, number] = [-5.5, 5.5];
export const SIDE_CAM_ANCHOR_B: readonly [number, number] = [5.5, 5.5];
export const SIDE_CAM_HEIGHT = 2.6;
export const SIDE_CAM_LOOK_AT: readonly [number, number, number] = [0, 1.1, 0];

/**
 * Factory world: one renderer + one scene shared across all factory jobs.
 * The avatar persists across environments; the cell is rebuilt from the
 * EnvSpec per job, and scene-level styling (background, fog, work light)
 * follows the spec. One GPU context total, visually isolated environments.
 */
export interface FactoryWorld {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly rig: CameraRig;
  readonly avatar: Avatar;
  cell: MachineCell;
  env: EnvSpec;
  /** Swap in a new generated environment (rebuilds the cell, restyles the scene). */
  setEnv(env: EnvSpec): void;
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) mat.dispose();
  });
}

export interface FactoryWorldOptions {
  /** Existing canvas to render into (defaults to an offscreen canvas). */
  canvas?: HTMLCanvasElement;
  /** Device pixel ratio for the visible preview canvas (default 1). */
  pixelRatio?: number;
}

export function createFactoryWorld(
  rig: CameraRig,
  env: EnvSpec,
  options: FactoryWorldOptions = {},
): FactoryWorld {
  const canvas = options.canvas ?? document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // Shapes the live preview only: capture renderers are per-camera and pin
  // ratio 1 themselves (see capture/batch.ts), so output frames are unaffected.
  renderer.setPixelRatio(options.pixelRatio ?? 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
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
  const workLight = new THREE.PointLight(0xfff2e0, 14, 6, 2);
  workLight.position.set(0.4, 2.2, 1.5);
  scene.add(workLight);
  const grid = new THREE.GridHelper(24, 48, 0x3a4150, 0x242a33);
  grid.position.y = 0.002;
  scene.add(grid);

  const avatar = createAvatar();
  scene.add(avatar.root);

  // First-person mounts ride the body; mount once (avatar persists).
  const vp = (id: string): THREE.PerspectiveCamera => {
    const found = rig.viewports.find((v) => v.id === id);
    if (!found) throw new Error(`viewport ${id} missing`);
    return found.camera;
  };
  const headCam = vp("head");
  headCam.position.set(0, 0.02, 0.16);
  avatar.face.add(headCam);
  const chestCam = vp("chest");
  chestCam.position.set(0, -0.3, 0.32);
  chestCam.rotation.set(-0.25, 0, 0);
  avatar.chestFace.add(chestCam);

  const world: FactoryWorld = {
    renderer,
    scene,
    rig,
    avatar,
    cell: null as unknown as MachineCell,
    env: null as unknown as EnvSpec,
    setEnv(next: EnvSpec): void {
      if (world.cell) {
        scene.remove(world.cell.root);
        disposeTree(world.cell.root);
      }
      world.env = next;
      world.cell = createMachineCell({
        palette: next.palette,
        atcSide: next.atcSide,
      });
      // Scenario scripts are authored in the machine frame; the whole cell
      // group carries the environment yaw so world-space bindings line up.
      world.cell.root.rotation.y = next.machineRotation;
      scene.add(world.cell.root);

      // The rig defines the static side cams in the machine frame too; re-aim
      // them with the yaw so they keep framing the cell. A world-locked side
      // cam goes static whenever the machine rotates away from its frustum.
      const [ax, az] = toWorldXZ(next, SIDE_CAM_ANCHOR_A);
      const [bx, bz] = toWorldXZ(next, SIDE_CAM_ANCHOR_B);
      vp("side-a").position.set(ax, SIDE_CAM_HEIGHT, az);
      vp("side-b").position.set(bx, SIDE_CAM_HEIGHT, bz);
      vp("side-a").lookAt(SIDE_CAM_LOOK_AT[0], SIDE_CAM_LOOK_AT[1], SIDE_CAM_LOOK_AT[2]);
      vp("side-b").lookAt(SIDE_CAM_LOOK_AT[0], SIDE_CAM_LOOK_AT[1], SIDE_CAM_LOOK_AT[2]);

      scene.background = new THREE.Color(next.palette.background);
      scene.fog = new THREE.Fog(next.palette.fog, next.fog.near, next.fog.far);
      workLight.position.set(next.workLight.x, next.workLight.y, next.workLight.z);
      workLight.intensity = next.workLight.intensity;
    },
  };
  world.setEnv(env);
  return world;
}
