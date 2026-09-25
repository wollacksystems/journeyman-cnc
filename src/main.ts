import "./style.css";
import { FrameClock } from "./clock";
import { CameraRig, VIEWPORT_GRID, type CameraId } from "./rig";
import { startInspectorHub } from "./inspector";
import { scenarios, scenarioById } from "./scenario/registry";
import type { ScenarioDef } from "./scenario/types";
import { validateScenario } from "./scenario/types";
import { driveScenario } from "./scenario/drive";
import { applyScenario } from "./sim/apply";
import { captureBatch, downloadBlob, CAPTURE_HEIGHT, CAPTURE_WIDTH } from "./capture/batch";
import { recordComposite } from "./capture/composite";
import { buildCaptureManifest } from "./manifest";
import { LOCKED_ENV } from "./factory/environment";
import { createSimulation, type Simulation } from "./factory/index";
import { createFactoryWorld } from "./factory/world";

const FPS = 30;

/**
 * Composite (webm) recording bitrate. Lower it (e.g. VITE_PREVIEW_BITS_PER_SECOND=900000)
 * for small, PR-embeddable preview clips; production captures use the 12 Mbps default.
 */
const COMPOSITE_BITS_PER_SECOND = Number(
  import.meta.env.VITE_PREVIEW_BITS_PER_SECOND ?? 12_000_000,
);

const scenarioProblems = scenarios.flatMap((candidate) =>
  validateScenario(candidate).map((problem) => `${candidate.id}: ${problem}`),
);
if (scenarioProblems.length > 0) {
  throw new Error(`Scenario validation failed: ${scenarioProblems.join("; ")}`);
}

let selectedScenario: ScenarioDef = scenarios[0]!;

const canvas = document.querySelector<HTMLCanvasElement>("#rig");
if (!canvas) throw new Error("#rig canvas missing");

const rig = new CameraRig();

// The app IS the factory world: the visible canvas renders through the
// factory's spec-driven environment. LOCKED_ENV reproduces the original
// Phase-0 look exactly; generated environments swap in via setEnv (both in
// the factory UI below and during factory captures).
const factoryWorld = createFactoryWorld(rig, LOCKED_ENV, {
  canvas,
  pixelRatio: Math.min(window.devicePixelRatio, 2),
});
const { renderer, scene, avatar, cell } = factoryWorld;

// First-person head/chest cameras are mounted onto the factory avatar by
// createFactoryWorld (single mount point shared by live preview and capture).

const inspectorHub = startInspectorHub();
const snapshotViewports = rig.viewports.map((v) => ({ id: v.id, label: v.label }));
const clock = new FrameClock(FPS);

// The first-person mounts ride the body (lean + bob) and the look pivots
// aim them, so the rig feeds read like wearable cameras on a moving torso.

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  rig.setAspect(w, h);
}
window.addEventListener("resize", resize);
resize();

function frameLoop(): void {
  const state = clock.tick();
  if (state) {
    applyScenario(driveScenario(selectedScenario, state.t), avatar, cell);
    rig.update(state.t, avatar.root);
    inspectorHub.publish({
      frame: state.frame,
      t: state.t,
      fps: clock.fps,
      viewports: snapshotViewports,
    });
  }
  rig.renderAll(renderer, scene, avatar.body);
}
renderer.setAnimationLoop(frameLoop);

if (import.meta.env.DEV) {
  // Composite overlay labels matching the 3x2 viewport grid.
  const labels = document.createElement("div");
  labels.id = "labels";
  for (const vp of rig.viewports) {
    const el = document.createElement("span");
    el.className = "vp-label";
    el.textContent = vp.label;
    el.style.left = `${(vp.cell[0] * 100) / VIEWPORT_GRID.cols}%`;
    el.style.top = `${(vp.cell[1] * 100) / VIEWPORT_GRID.rows}%`;
    labels.appendChild(el);
  }
  document.body.appendChild(labels);

  const openBtn = document.createElement("button");
  openBtn.id = "open-inspector";
  openBtn.textContent = "OPEN INSPECTOR";
  openBtn.addEventListener("click", () => {
    window.open(
      import.meta.env.BASE_URL + "inspector.html",
      "journeyman-sim-inspector",
      "width=440,height=340",
    );
  });
  document.body.appendChild(openBtn);

  // Capture toolbar: real-time composite + deterministic MP4 corpus.
  const status = document.createElement("div");
  status.id = "capture-status";
  status.textContent = "idle";
  document.body.appendChild(status);

  const toolbar = document.createElement("div");
  toolbar.id = "capture-toolbar";

  const scenarioSelect = document.createElement("select");
  scenarioSelect.id = "scenario-select";
  for (const candidate of scenarios) {
    const option = document.createElement("option");
    option.value = candidate.id;
    option.textContent = `${candidate.id} — ${candidate.durationSec}s`;
    scenarioSelect.appendChild(option);
  }
  scenarioSelect.value = selectedScenario.id;
  scenarioSelect.addEventListener("change", () => {
    const next = scenarioById.get(scenarioSelect.value);
    if (!next || busy) return;
    selectedScenario = next;
    clock.reset();
    statusFor(`selected ${selectedScenario.id}`);
  });
  toolbar.appendChild(scenarioSelect);

  const recBtn = document.createElement("button");
  recBtn.textContent = "REC COMPOSITE";
  recBtn.addEventListener("click", () => {
    void compositeFlow();
  });

  const corpusBtn = document.createElement("button");
  corpusBtn.textContent = "RENDER CORPUS";
  corpusBtn.addEventListener("click", () => {
    void batchFlow();
  });

  toolbar.append(recBtn, corpusBtn);
  document.body.appendChild(toolbar);

  // Factory UI: plan + render generated corpora (seeded, deterministic).
  const factoryBox = document.createElement("div");
  factoryBox.id = "factory-box";

  const factorySeed = document.createElement("input");
  factorySeed.id = "factory-seed";
  factorySeed.type = "number";
  factorySeed.value = "2026";
  factorySeed.min = "0";
  factorySeed.title = "Factory root seed (same seed -> identical corpus)";

  const factoryEnvs = document.createElement("input");
  factoryEnvs.id = "factory-envs";
  factoryEnvs.type = "number";
  factoryEnvs.value = "2";
  factoryEnvs.min = "1";
  factoryEnvs.max = "8";
  factoryEnvs.title = "Generated environments";

  const factoryPerEnv = document.createElement("input");
  factoryPerEnv.id = "factory-per-env";
  factoryPerEnv.type = "number";
  factoryPerEnv.value = "1";
  factoryPerEnv.min = "1";
  factoryPerEnv.max = "4";
  factoryPerEnv.title = "Scenarios per environment";

  const factoryPlanBtn = document.createElement("button");
  factoryPlanBtn.textContent = "PLAN FACTORY";
  factoryPlanBtn.addEventListener("click", () => {
    factorySim = readFactorySim();
    const described = factorySim.describe();
    statusFor(
      `planned seed ${described.seed}: ${described.scenarioCount} scenarios across ${described.envCount} envs — ${described.environments.flatMap((e) => e.scenarios.map((s) => s.id)).join(", ")}`,
    );
  });

  const factoryRenderBtn = document.createElement("button");
  factoryRenderBtn.textContent = "RENDER FACTORY";
  factoryRenderBtn.addEventListener("click", () => {
    void factoryFlow();
  });

  // Cycles the live canvas through the planned environments (generated cell
  // orientation/palette/lighting + the generated scenario's beats) without
  // committing to a full render.
  const factoryPreviewBtn = document.createElement("button");
  factoryPreviewBtn.textContent = "PREVIEW ENV";
  factoryPreviewBtn.title = "Cycle the live view through the planned generated environments";
  factoryPreviewBtn.addEventListener("click", () => {
    factorySim = factorySim ?? readFactorySim();
    const sim = factorySim;
    const jobs = sim.plan().jobs;
    if (jobs.length === 0) return;
    factoryPreviewDispose?.();
    factoryPreviewIndex = (factoryPreviewIndex + 1) % jobs.length;
    factoryPreviewDispose = sim.preview(factoryWorld, factoryPreviewIndex, {
      onJob: (job) => {
        selectedScenario = job.scenario;
        clock.reset();
        statusFor(
          `previewing ${factoryPreviewIndex + 1}/${jobs.length}: ${job.scenario.id} (${job.env.variant}, ${job.env.palette.name}, rot ${(job.env.machineRotation * 180) / Math.PI}°)`,
        );
      },
    });
  });
  let factoryPreviewIndex = -1;
  let factoryPreviewDispose: (() => void) | null = null;

  factoryBox.append(
    factorySeed,
    factoryEnvs,
    factoryPerEnv,
    factoryPlanBtn,
    factoryPreviewBtn,
    factoryRenderBtn,
  );
  document.body.appendChild(factoryBox);

  let factorySim: Simulation | null = null;
  const readFactorySim = (): Simulation =>
    createSimulation({
      seed: Number(factorySeed.value) >>> 0,
      shape: {
        envCount: Math.max(1, Number(factoryEnvs.value) || 1),
        perEnv: Math.max(1, Number(factoryPerEnv.value) || 1),
      },
    });

  let busy = false;
  const setBusy = (value: boolean): void => {
    busy = value;
    scenarioSelect.disabled = value;
    recBtn.disabled = value;
    corpusBtn.disabled = value;
    for (const el of [
      factorySeed,
      factoryEnvs,
      factoryPerEnv,
      factoryPlanBtn,
      factoryPreviewBtn,
      factoryRenderBtn,
    ]) {
      el.disabled = value;
    }
  };
  const statusFor = (text: string): void => {
    status.textContent = text;
  };

  // Dev-only capture scoping: `?capture=sensor-trip:side-a+head,way-lube`
  // narrows the corpus batch to individual scenario/camera units. A 1080p clip
  // is minutes of software-GL rendering, so a full batch is hours of wall clock
  // — long enough to be interrupted by a reload, a renderer crash, or a thermal
  // stall. Re-rendering a clip that already landed would also mint "file
  // (1).mp4" duplicates, so the footage driver asks for exactly the units still
  // missing and a lost page costs one clip instead of the whole run.
  const captureSpec = new URLSearchParams(window.location.search).get("capture");
  const captureUnits: Array<{ scenario: ScenarioDef; cameras: CameraId[] }> = [];
  if (captureSpec) {
    const wanted = new Map<string, string[] | null>();
    for (const entry of captureSpec.split(",")) {
      const [id, cameraList] = entry.split(":");
      if (id?.trim()) {
        wanted.set(
          id.trim(),
          cameraList ? cameraList.split("+").map((camera) => camera.trim()) : null,
        );
      }
    }
    for (const candidate of scenarios) {
      if (!wanted.has(candidate.id)) continue;
      const requested = wanted.get(candidate.id);
      const cameras = requested
        ? candidate.cameras.filter((camera) => requested.includes(camera))
        : [...candidate.cameras];
      if (cameras.length > 0) captureUnits.push({ scenario: candidate, cameras });
    }
    if (captureUnits.length === 0) {
      statusFor(`capture filter matched nothing: ${captureSpec}`);
      throw new Error(`?capture= matched no scenario/camera: ${captureSpec}`);
    }
  } else {
    for (const candidate of scenarios) {
      captureUnits.push({ scenario: candidate, cameras: [...candidate.cameras] });
    }
  }

  async function compositeFlow(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const activeScenario = selectedScenario;
      clock.reset(); // wall-clock composite runs a fresh 0..duration loop
      statusFor(`recording ${activeScenario.id} composite...`);
      const blob = await recordComposite(
        renderer,
        activeScenario.durationSec,
        activeScenario.fps,
        (t) => {
          statusFor(`recording ${activeScenario.id} composite ${t.toFixed(1)}s`);
        },
        COMPOSITE_BITS_PER_SECOND,
      );
      downloadBlob(blob, `renders/${activeScenario.id}/composite.webm`);
      statusFor(`saved renders/${activeScenario.id}/composite.webm`);
    } catch (error) {
      console.error(error);
      statusFor(`composite failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function batchFlow(): Promise<void> {
    if (busy) return;
    setBusy(true);
    renderer.setAnimationLoop(null); // batch drives its own frames; don't compete with the live canvas
    try {
      let totalClips = 0;
      statusFor(`encoding corpus: ${captureUnits.length} scenarios`);
      for (let si = 0; si < captureUnits.length; si++) {
        const unit = captureUnits[si];
        if (!unit) throw new Error(`capture unit ${si} missing`);
        const activeScenario = unit.scenario;
        const totalFrames = Math.round(activeScenario.durationSec * activeScenario.fps);
        statusFor(
          `encoding ${activeScenario.id} (${si + 1}/${captureUnits.length}): ${unit.cameras.length} cameras x ${totalFrames} frames (${CAPTURE_WIDTH}x${CAPTURE_HEIGHT})`,
        );
        const startedUtc = new Date().toISOString();
        let clipsSaved = 0;
        await captureBatch({
          scenario: activeScenario,
          rig,
          scene,
          avatar,
          cell,
          cameras: unit.cameras,
          onProgress: (p) => {
            statusFor(
              `scenario ${activeScenario.id}: ${p.camera} ${p.frame}/${p.totalFrames} (camera ${p.cameraIndex + 1}/${p.cameraTotal})`,
            );
          },
          // Save each clip the moment it finalizes rather than after the whole
          // scenario: a failure on a late camera then costs one clip instead of
          // every clip already muxed, and the encoder stops holding finished
          // MP4s in memory for the rest of the batch.
          onClip: (clip) => {
            clipsSaved += 1;
            downloadBlob(clip.blob, `renders/${activeScenario.id}/${clip.camera}.mp4`);
          },
        });
        const manifest = buildCaptureManifest(
          activeScenario,
          rig,
          CAPTURE_WIDTH,
          CAPTURE_HEIGHT,
          startedUtc,
        );
        downloadBlob(
          new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }),
          `renders/${activeScenario.id}/manifest.json`,
        );
        totalClips += clipsSaved;
        statusFor(
          `saved ${activeScenario.id}: ${clipsSaved} clips + manifest (${si + 1}/${captureUnits.length})`,
        );
      }
      statusFor(
        `saved renders/: ${captureUnits.length} scenarios + ${totalClips} clips + manifests`,
      );
    } catch (error) {
      console.error(error);
      statusFor(`batch failed: ${String(error)}`);
    } finally {
      renderer.setAnimationLoop(frameLoop);
      setBusy(false);
    }
  }

  async function factoryFlow(): Promise<void> {
    if (busy) return;
    setBusy(true);
    renderer.setAnimationLoop(null); // factory drives its own frames
    try {
      const sim = factorySim ?? readFactorySim();
      factorySim = sim;
      statusFor(
        `factory seed ${sim.spec.seed}: rendering ${sim.describe().scenarioCount} generated scenario(s)...`,
      );
      const out = await sim.render(factoryWorld, {
        onProgress: (p, job) => {
          statusFor(
            `${job.scenario.id}: ${p.camera} ${p.frame}/${p.totalFrames} (camera ${p.cameraIndex + 1}/${p.cameraTotal})`,
          );
        },
      });
      statusFor(`exporting corpus ${sim.spec.seed}: ${out.results.length} scenario(s)...`);
      const summary = await sim.export(sim.plan(), out.results);
      statusFor(
        `saved ${summary.corpusRoot}: ${summary.scenarioCount} scenarios, ${summary.clipCount} clips + index.json (seed ${summary.rootSeed})`,
      );
    } catch (error) {
      console.error(error);
      statusFor(`factory failed: ${String(error)}`);
    } finally {
      renderer.setAnimationLoop(frameLoop);
      setBusy(false);
    }
  }
}
