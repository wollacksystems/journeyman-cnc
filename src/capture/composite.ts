import * as THREE from "three";

function pickWebMMime(): string {
  if (typeof MediaRecorder === "undefined") throw new Error("MediaRecorder not supported");
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? "video/webm";
}

type CapturableCanvas = HTMLCanvasElement & {
  captureStream?: (frameRequestRate?: number) => MediaStream;
};

/**
 * Real-time composite recording of the on-screen 6-viewport rig via
 * canvas.captureStream + MediaRecorder. Produces a single webm of the full
 * composite for the Ph.5 deliverable and as an easy eyeball artifact.
 */
export async function recordComposite(
  renderer: THREE.WebGLRenderer,
  durationSec: number,
  fps: number,
  onProgress?: (seconds: number) => void,
  videoBitsPerSecond = 12_000_000,
): Promise<Blob> {
  const canvas = renderer.domElement as CapturableCanvas;
  const stream = canvas.captureStream?.(fps);
  if (!stream) throw new Error("canvas.captureStream not supported in this browser");

  const mimeType = pickWebMMime();
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond });

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  recorder.start(250);
  const started = performance.now();
  const totalMs = durationSec * 1000;
  while (performance.now() - started < totalMs) {
    onProgress?.(durationSec * ((performance.now() - started) / totalMs));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  recorder.stop();
  await stopped;
  onProgress?.(durationSec);

  return new Blob(chunks, { type: mimeType.split(";")[0] ?? "video/webm" });
}
