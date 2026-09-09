/**
 * Dev-only live inspector transport.
 *
 * The rig publishes frame-aligned snapshots over a BroadcastChannel; the
 * inspector window (inspector.html + inspector-page.ts) subscribes and
 * renders them. A throttled localStorage mirror keeps the last snapshot so a
 * freshly opened inspector immediately shows current state. No UI, no
 * side effects here — safe to import from the main bundle.
 */
export interface InspectorSnapshot {
  frame: number;
  /** Simulation time (s) of the published frame. */
  t: number;
  fps: number;
  viewports: Array<{ id: string; label: string }>;
}

const CHANNEL = "journeyman-sim/inspector";
const STORAGE_KEY = "journeyman-sim/inspector/last";
const MIRROR_INTERVAL_MS = 500;

export interface InspectorHub {
  publish(snapshot: InspectorSnapshot): void;
}

export function startInspectorHub(): InspectorHub {
  const channel: BroadcastChannel | null =
    typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  let lastMirror = 0;
  return {
    publish(snapshot: InspectorSnapshot): void {
      channel?.postMessage(snapshot);
      const now = performance.now();
      if (now - lastMirror >= MIRROR_INTERVAL_MS) {
        lastMirror = now;
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
        } catch {
          // Storage blocked — the live channel still works.
        }
      }
    },
  };
}

/** Subscribe to inspector snapshots; returns an unsubscribe function. */
export function subscribeInspector(onSnapshot: (s: InspectorSnapshot) => void): () => void {
  const channel: BroadcastChannel | null =
    typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  if (channel) channel.onmessage = (event) => onSnapshot(event.data as InspectorSnapshot);
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached) onSnapshot(JSON.parse(cached) as InspectorSnapshot);
  } catch {
    // Ignore unreadable cache.
  }
  return () => channel?.close();
}
