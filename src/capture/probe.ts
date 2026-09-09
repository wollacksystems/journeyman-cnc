import { canEncodeVideo, type VideoCodec } from "mediabunny";

/** Codec preference order for MP4 batch capture (H.264 first, then VP9/AV1). */
const PREFERRED: readonly VideoCodec[] = ["avc", "vp9", "av1"];

/**
 * Pick the first video codec this browser can encode at the given frame size.
 * Throws when none of the preferred codecs are available (ancient browsers).
 */
export async function pickVideoCodec(width: number, height: number): Promise<VideoCodec> {
  for (const codec of PREFERRED) {
    if (await canEncodeVideo(codec, { width, height })) return codec;
  }
  throw new Error("No encodable video codec (avc/vp9/av1) for this browser.");
}
