/**
 * Frame-aligned deterministic clock.
 *
 * Simulation state is a pure function of frame time: the clock quantizes wall
 * time to whole frames at a fixed fps, so every rendered frame has a stable
 * index and timestep regardless of display refresh rate or jitter. This is the
 * property the capture pipeline (Phase 2) relies on: frame N of a recording
 * always corresponds to simulation time N / fps.
 */
export interface ClockState {
  /** Current frame index (monotonically increasing integer). */
  readonly frame: number;
  /** Simulation time of the current frame in seconds (frame / fps). */
  readonly t: number;
  /** Fixed timestep in seconds (1 / fps). */
  readonly dt: number;
  /** Frames the clock advanced since the previous tick (0 or more). */
  readonly steps: number;
}

export class FrameClock {
  readonly fps: number;
  private readonly frameDuration: number;
  private start = performance.now();
  private lastFrame = -1;

  constructor(fps = 30) {
    this.fps = fps;
    this.frameDuration = 1000 / fps;
  }

  /** Reset the wall-clock origin (e.g. when capture starts). */
  reset(): void {
    this.start = performance.now();
    this.lastFrame = -1;
  }

  /**
   * Advance to the latest whole frame boundary. Returns null when no new
   * frame boundary has been crossed since the previous tick (i.e. the render
   * would be a duplicate at this fps and can be skipped).
   */
  tick(): ClockState | null {
    const elapsed = performance.now() - this.start;
    const target = Math.floor(elapsed / this.frameDuration);
    if (target <= this.lastFrame) return null;
    const steps = target - this.lastFrame;
    this.lastFrame = target;
    return {
      frame: target,
      t: target / this.fps,
      dt: steps / this.fps,
      steps,
    };
  }
}
