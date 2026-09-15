import type { CameraRig } from "../rig";
import { buildCaptureManifest, type CaptureManifest } from "../manifest";
import type { ScenarioDef } from "../scenario/types";
import { ENGINE_VERSION } from "../version";
import type { EnvSpec } from "./environment";
import type { FactoryJob } from "./plan";

/**
 * Capture manifest extended with the environment + factory provenance blocks
 * that make generated footage traceable and recallable: ingest can group clips
 * by environment, replay a corpus from its root seed, and distinguish
 * generated ground truth from the locked hand-authored corpus.
 */
export type FactoryCaptureManifest = CaptureManifest & {
  environment: {
    id: string;
    seed: number;
    variant: string;
    machineRotation: number;
    atcSide: 1 | -1;
    palette: string;
  };
  factory: {
    generator: "journeyman-sim factory";
    engineVersion: string;
    templateId: string;
    rootScenarioId: string;
    rootSeed: number;
    generatedAtUtc: string;
  };
};

export function buildFactoryManifest(
  job: FactoryJob,
  rig: CameraRig,
  width: number,
  height: number,
  startedUtc: string,
  rootSeed: number,
): FactoryCaptureManifest {
  const base = buildCaptureManifest(job.scenario as ScenarioDef, rig, width, height, startedUtc);
  const env: EnvSpec = job.env;
  return {
    ...base,
    capture: {
      ...base.capture,
      sim: {
        ...base.capture.sim,
        totalFrames: Math.round(job.scenario.durationSec * job.scenario.fps),
      },
    },
    environment: {
      id: env.id,
      seed: env.seed,
      variant: env.variant,
      machineRotation: env.machineRotation,
      atcSide: env.atcSide,
      palette: env.palette.name,
    },
    factory: {
      generator: "journeyman-sim factory",
      engineVersion: ENGINE_VERSION,
      templateId: job.scenario.templateId,
      rootScenarioId: job.scenario.id,
      rootSeed,
      generatedAtUtc: startedUtc,
    },
  };
}
