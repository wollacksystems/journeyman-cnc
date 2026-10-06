import * as THREE from "three";
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } from "mediabunny";
import type { CameraId } from "../rig";
import type { Avatar } from "../avatar";
import type { MachineCell } from "../cell";
import type { CameraRig } from "../rig";
import type { ScenarioDef } from "../scenario/types";
import { driveScenario } from "../scenario/drive";
import { applyScenario } from "../sim/apply";
import { pickVideoCodec } from "./probe";

/**
 * Locked production capture size (see README approach: 1080p / 30 fps).
 * import.meta.env is optional-chained so these constants evaluate in plain
 * Node ESM too (headless scripts import this module through the factory
 * barrel; there import.meta.env is undefined and the defaults apply).
 */
export const CAPTURE_WIDTH = Number(import.meta.env?.VITE_CAPTURE_WIDTH ?? 1920);
export const CAPTURE_HEIGHT = Number(import.meta.env?.VITE_CAPTURE_HEIGHT ?? 1080);

export interface BatchOptions {
  scenario: ScenarioDef;
  rig: CameraRig;
  scene: THREE.Scene;
  avatar: Avatar;
  cell: MachineCell;
  width?: number;
  height?: number;
  /**
   * Cameras to render, in order; defaults to the scenario's whole list.
   * Scoping is what makes a multi-hour batch resumable a few clips at a time.
   */
  cameras?: CameraId[];
  onProgress?: (p: BatchProgress) => void;
  /**
   * Streaming hook, called the instant a clip finishes muxing and before the
   * next camera allocates its renderer. When supplied the caller takes
   * ownership and the blob is NOT retained in the result, so peak memory stays
   * at one clip instead of a whole scenario's worth. That matters at 1080p,
   * where holding every MP4 is enough to stall the renderer mid-run.
   */
  onClip?: (clip: BatchClip) => void;
}

export interface BatchProgress {
  camera: CameraId;
  frame: number;
  totalFrames: number;
  cameraIndex: number;
  cameraTotal: number;
}

export interface BatchClip {
  camera: CameraId;
  blob: Blob;
}

export interface BatchResult {
  /** Clips in camera order; empty when `onClip` streamed them out instead. */
  clips: BatchClip[];
}

function renderFrameAt(
  options: BatchOptions,
  cameraId: CameraId,
  t: number,
  renderer: THREE.WebGLRenderer,
): void {
  const { scenario, rig, scene, avatar, cell } = options;
  const w = options.width ?? CAPTURE_WIDTH;
  const h = options.height ?? CAPTURE_HEIGHT;
  applyScenario(driveScenario(scenario, t), avatar, cell);
  scene.updateMatrixWorld(true);
  rig.renderCamera(renderer, scene, avatar.body, cameraId, w, h);
}

/**
 * Render the full scenario deterministically, one clip per production camera,
 * encoding straight to MP4 in memory with mediabunny (CanvasSource -> WebCodecs).
 *
 * Determinism: frame f of every clip is driven at sim time t = f / fps, so
 * clips are frame-aligned with each other and with the composite webm that
 * records the same sim time. Renders buffer to memory (BufferTarget) and are
 * returned as blobs for the caller to save under renders/ — or streamed out one
 * at a time via onClip, which long 1080p batches should do to bound memory.
 */
export async function captureBatch(options: BatchOptions): Promise<BatchResult> {
  if (!import.meta.env?.DEV) {
    // Batch capture is a dev/tooling affordance; keep it out of the demo build.
    throw new Error("RENDER CORPUS is a dev-only action");
  }
  const { scenario } = options;
  const w = options.width ?? CAPTURE_WIDTH;
  const h = options.height ?? CAPTURE_HEIGHT;
  const fps = scenario.fps;
  const totalFrames = Math.round(scenario.durationSec * fps);
  const codec = await pickVideoCodec(w, h);

  const clips: BatchResult["clips"] = [];
  const cameraList = options.cameras ?? scenario.cameras;
  const cameraTotal = cameraList.length;

  for (let ci = 0; ci < cameraTotal; ci++) {
    const cameraId = cameraList[ci];
    if (!cameraId) throw new Error("scenario camera list empty");

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    const source = new CanvasSource(canvas, {
      codec,
      quality: new Quality("high"),
      keyFrameInterval: 1,
    });

    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target,
    });
    output.addVideoTrack(source, { frameRate: fps, name: cameraId });
    await output.start();

    for (let f = 0; f < totalFrames; f++) {
      const t = f / fps;
      renderFrameAt(options, cameraId, t, renderer);
      await source.add(t, 1 / fps);
      options.onProgress?.({
        camera: cameraId,
        frame: f + 1,
        totalFrames,
        cameraIndex: ci,
        cameraTotal,
      });
    }
    source.close();
    await output.finalize();

    const buffer = target.buffer;
    if (!buffer) throw new Error(`No output buffer produced for ${cameraId}`);
    const clip: BatchClip = { camera: cameraId, blob: new Blob([buffer], { type: "video/mp4" }) };

    // Hand the clip off before the next camera spins up: holding a whole
    // scenario's MP4s in memory starves the renderer, and a stall here takes
    // the entire run down with it while nothing has reached disk yet.
    if (options.onClip) options.onClip(clip);
    else clips.push(clip);

    // dispose() frees GPU resources but leaves the WebGL context allocated,
    // and Chromium caps how many live contexts a page may hold. Allocating
    // one renderer per camera exhausts that budget partway through a long
    // batch and the tab stalls — so drop the context explicitly, then the
    // canvas backing it.
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.width = 0;
    canvas.height = 0;
  }

  return { clips };
}

/** Trigger a browser download of a blob to a (fake) local path under renders/. */
export function downloadBlob(blob: Blob, path: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = path;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on a delay: an immediate revoke can cancel the browser's download
  // start when many downloads fire back-to-back (corpus export). Leaked URLs
  // are reclaimed by the delay; blobs are small and this is dev-only.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
