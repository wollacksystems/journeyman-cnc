import * as THREE from "three";

/**
 * Six-viewport scissored camera rig.
 *
 * One WebGLRenderer draws the scene once per camera into its own grid cell
 * (setViewport + setScissor), so the frame stays frame-aligned for capture
 * (Phase 2) and scene setup is shared across cameras.
 *
 * Viewports (3x2 grid):
 *   0 — side A (static), 1 — side B (static): wide shots of the cell.
 *   2 — head cam, 3 — chest cam: mounted on the avatar by main.ts; the avatar
 *       body is hidden per-camera while those render, so it never occludes
 *       its own view.
 *   4 — orbit debug cam, 5 — follow debug cam.
 */
export const VIEWPORT_GRID = { cols: 3, rows: 2 } as const;

export type CameraId = "side-a" | "side-b" | "head" | "chest" | "debug-orbit" | "debug-follow";

export interface Viewport {
  readonly id: CameraId;
  readonly label: string;
  readonly camera: THREE.PerspectiveCamera;
  /** Grid cell [col, row], origin top-left. */
  readonly cell: readonly [number, number];
  /** First-person cameras hide the avatar body while they render. */
  readonly firstPerson: boolean;
}

function makeCamera(id: CameraId, fov: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.05, 200);
  camera.name = id;
  return camera;
}

export class CameraRig {
  readonly viewports: readonly Viewport[];

  constructor() {
    const sideA = makeCamera("side-a", 55);
    sideA.position.set(-5.5, 2.6, 5.5);
    sideA.lookAt(0, 1.1, 0);

    const sideB = makeCamera("side-b", 55);
    sideB.position.set(5.5, 2.6, 5.5);
    sideB.lookAt(0, 1.1, 0);

    // Head/chest are mounted onto the avatar by main.ts.
    const head = makeCamera("head", 70);
    const chest = makeCamera("chest", 80);

    const orbit = makeCamera("debug-orbit", 60);
    const follow = makeCamera("debug-follow", 60);
    follow.position.set(0, 2.4, -3.4);

    this.viewports = [
      { id: "side-a", label: "SIDE A", camera: sideA, cell: [0, 0], firstPerson: false },
      { id: "side-b", label: "SIDE B", camera: sideB, cell: [1, 0], firstPerson: false },
      { id: "head", label: "HEAD", camera: head, cell: [2, 0], firstPerson: true },
      { id: "chest", label: "CHEST", camera: chest, cell: [0, 1], firstPerson: true },
      { id: "debug-orbit", label: "DEBUG ORBIT", camera: orbit, cell: [1, 1], firstPerson: false },
      {
        id: "debug-follow",
        label: "DEBUG FOLLOW",
        camera: follow,
        cell: [2, 1],
        firstPerson: false,
      },
    ];
  }

  /** Recompute per-cell aspect ratios on resize. */
  setAspect(width: number, height: number): void {
    const cellAspect = width / height / (VIEWPORT_GRID.cols / VIEWPORT_GRID.rows);
    for (const vp of this.viewports) {
      vp.camera.aspect = cellAspect;
      vp.camera.updateProjectionMatrix();
    }
  }

  /** Update animated debug cameras; static and mounted cams are untouched. */
  update(t: number, avatarRoot: THREE.Object3D): void {
    const orbit = this.viewports.find((vp) => vp.id === "debug-orbit")?.camera;
    if (orbit) {
      const a = t * 0.25;
      orbit.position.set(Math.cos(a) * 6.5, 6.5, Math.sin(a) * 6.5); // high overview, clear of the 3.4m walls at every phase
      orbit.lookAt(0, 0.9, 0);
    }
    const follow = this.viewports.find((vp) => vp.id === "debug-follow")?.camera;
    if (follow) {
      const p = avatarRoot.position;
      follow.position.set(p.x + 2.6, p.y + 2.3, p.z + 0.6); // offset to the side, clear of the machine
      follow.lookAt(p.x, p.y + 1.1, p.z);
    }
  }

  /** Render every viewport into its grid cell via scissor + viewport. */
  renderAll(renderer: THREE.WebGLRenderer, scene: THREE.Scene, avatarBody: THREE.Object3D): void {
    const { cols, rows } = VIEWPORT_GRID;
    const size = new THREE.Vector2();
    renderer.getSize(size); // CSS pixels; setViewport/setScissor take CSS px.
    const cellW = Math.floor(size.x / cols);
    const cellH = Math.floor(size.y / rows);

    renderer.setScissorTest(true);
    for (const vp of this.viewports) {
      const [col, row] = vp.cell;
      const x = col * cellW;
      const y = size.y - (row + 1) * cellH; // WebGL origin: bottom-left.
      renderer.setViewport(x, y, cellW, cellH);
      renderer.setScissor(x, y, cellW, cellH);
      avatarBody.visible = !vp.firstPerson;
      renderer.render(scene, vp.camera);
    }
    renderer.setScissorTest(false);
  }

  /**
   * Render a single camera full-frame into the renderer's drawing buffer
   * (aspect matched to the given pixel size). Used by the batch capture
   * pipeline to produce one dedicated canvas stream per production camera.
   */
  renderCamera(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    avatarBody: THREE.Object3D,
    id: CameraId,
    width: number,
    height: number,
  ): void {
    const vp = this.viewports.find((v) => v.id === id);
    if (!vp) throw new Error(`viewport ${id} missing`);
    const prevAspect = vp.camera.aspect;
    vp.camera.aspect = width / height;
    vp.camera.updateProjectionMatrix();
    renderer.setViewport(0, 0, width, height);
    renderer.setScissor(0, 0, width, height);
    renderer.setScissorTest(true);
    avatarBody.visible = !vp.firstPerson;
    renderer.render(scene, vp.camera);
    renderer.setScissorTest(false);
    vp.camera.aspect = prevAspect;
    vp.camera.updateProjectionMatrix();
  }
}
