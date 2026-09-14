import {
  CAPTURE_HEIGHT,
  CAPTURE_WIDTH,
  captureBatch,
  type BatchOptions,
  type BatchProgress,
} from "../capture/batch";
import type { FactoryCaptureManifest } from "./manifest";
import { buildFactoryManifest } from "./manifest";
import type { FactoryJob } from "./plan";
import type { FactoryWorld } from "./world";

/**
 * Factory capture stage: renders one generated job through the existing
 * deterministic batch pipeline. The world's cell is rebuilt from the job's
 * EnvSpec first, so every generated environment shoots with its own geometry
 * placement, palette, lighting, and fog while sharing one renderer/scene.
 */
export interface FactoryRenderOptions {
  width?: number;
  height?: number;
  /**
   * Corpus root seed recorded in the manifest provenance. Defaults to the
   * environment's own seed when a job is rendered outside a planned corpus.
   */
  rootSeed?: number;
  onProgress?: (p: BatchProgress) => void;
}

export interface FactoryCaptureResult {
  job: FactoryJob;
  clips: Array<{ camera: string; blob: Blob }>;
  manifest: FactoryCaptureManifest;
  startedUtc: string;
  width: number;
  height: number;
  totalFrames: number;
}

export async function renderFactoryJob(
  world: FactoryWorld,
  job: FactoryJob,
  options: FactoryRenderOptions = {},
): Promise<FactoryCaptureResult> {
  const width = options.width ?? CAPTURE_WIDTH;
  const height = options.height ?? CAPTURE_HEIGHT;
  const scenario = job.scenario;
  const totalFrames = Math.round(scenario.durationSec * scenario.fps);
  const startedUtc = new Date().toISOString();

  world.setEnv(job.env);
  // One shared renderer sized for the full-frame per-camera renders
  // (captureBatch drives rig.renderCamera with these dimensions per frame).
  world.renderer.setSize(width, height, false);

  const batchOptions: BatchOptions = {
    scenario,
    rig: world.rig,
    scene: world.scene,
    avatar: world.avatar,
    cell: world.cell,
    width,
    height,
  };
  if (options.onProgress) batchOptions.onProgress = options.onProgress;
  const result = await captureBatch(batchOptions);

  const manifest = buildFactoryManifest(
    job,
    world.rig,
    width,
    height,
    startedUtc,
    options.rootSeed ?? job.env.seed,
  );
  return { job, clips: result.clips, manifest, startedUtc, width, height, totalFrames };
}
