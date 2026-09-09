import * as THREE from "three";
import type { CameraId, CameraRig } from "./rig";
import type { ScenarioDef } from "./scenario/types";
import { ENGINE_VERSION } from "./version";

export interface CameraIntrinsic {
  id: CameraId;
  label: string;
  width: number;
  height: number;
  fov: number;
  position: [number, number, number];
  lookAt: [number, number, number];
  firstPerson: boolean;
}

export interface CaptureManifest {
  capture: {
    id: string;
    startedUtc: string;
    engineVersion: string;
    scenario: { id: string; title: string; role: string };
    sim: { fps: number; durationSec: number; totalFrames: number };
  };
  cameras: CameraIntrinsic[];
  timeline: {
    beats: Array<{ id: string; label: string; tStart: number; tEnd: number; cameraHint: CameraId }>;
    narration: Array<{ t: number; text: string }>;
  };
  lesson: { title: string; body: string };
}

/**
 * Build the capture manifest committed alongside a corpus: capture identity,
 * camera intrinsics read back from the live rig, the beat/narration timeline
 * (ground truth for ingest + clip playback), and the lesson.
 */
export function buildCaptureManifest(
  def: ScenarioDef,
  rig: CameraRig,
  width: number,
  height: number,
  startedUtc: string,
): CaptureManifest {
  const dir = new THREE.Vector3();
  const cameras: CameraIntrinsic[] = [];
  for (const vp of rig.viewports) {
    if (!def.cameras.includes(vp.id)) continue;
    vp.camera.getWorldDirection(dir);
    cameras.push({
      id: vp.id,
      label: vp.label,
      width,
      height,
      fov: vp.camera.fov,
      position: [vp.camera.position.x, vp.camera.position.y, vp.camera.position.z],
      lookAt: [
        vp.camera.position.x + dir.x,
        vp.camera.position.y + dir.y,
        vp.camera.position.z + dir.z,
      ],
      firstPerson: vp.firstPerson,
    });
  }

  return {
    capture: {
      id: `${def.id}-${startedUtc}`,
      startedUtc,
      engineVersion: ENGINE_VERSION,
      scenario: { id: def.id, title: def.title, role: def.role },
      sim: {
        fps: def.fps,
        durationSec: def.durationSec,
        totalFrames: Math.round(def.durationSec * def.fps),
      },
    },
    cameras,
    timeline: {
      beats: def.beats.map((b) => ({
        id: b.id,
        label: b.label,
        tStart: b.tStart,
        tEnd: b.tEnd,
        cameraHint: b.cameraHint,
      })),
      narration: def.narration.map((n) => ({ ...n })),
    },
    lesson: { title: def.lesson.title, body: def.lesson.body },
  };
}
