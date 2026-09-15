import "./style.css";
import { FrameClock } from "./clock";
import { CameraRig, VIEWPORT_GRID } from "./rig";
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
import { planFactory, type FactoryPlan } from "./factory/plan";
import { createFactoryWorld } from "./factory/world";
import { renderFactoryJob } from "./factory/render";
import { saveCorpus } from "./factory/corpus-save";
import type { FactoryCaptureResult } from "./factory/render";

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
    factoryPlan = readFactoryPlan();
    statusFor(
      `planned seed ${factoryPlan.rootSeed}: ${factoryPlan.jobs.length} scenarios across ${factoryPlan.envCount} envs — ${factoryPlan.jobs.map((j) => j.scenario.id).join(", ")}`,
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
    factoryPlan = factoryPlan ?? readFactoryPlan();
    if (factoryPlan.jobs.length === 0) return;
    factoryPreviewIndex = (factoryPreviewIndex + 1) % factoryPlan.jobs.length;
    const job = factoryPlan.jobs[factoryPreviewIndex];
    if (!job) return;
    factoryWorld.setEnv(job.env);
    selectedScenario = job.scenario;
    clock.reset();
    statusFor(
      `previewing ${factoryPreviewIndex + 1}/${factoryPlan.jobs.length}: ${job.scenario.id} (${job.env.variant}, ${job.env.palette.name}, rot ${(job.env.machineRotation * 180) / Math.PI}°)`,
    );
  });
  let factoryPreviewIndex = -1;

  factoryBox.append(
    factorySeed,
    factoryEnvs,
    factoryPerEnv,
    factoryPlanBtn,
    factoryPreviewBtn,
    factoryRenderBtn,
  );
  document.body.appendChild(factoryBox);

  let factoryPlan: FactoryPlan | null = null;
  const readFactoryPlan = (): FactoryPlan =>
    planFactory(Number(factorySeed.value) >>> 0, {
      envCount: Math.max(1, Number(factoryEnvs.value) || 1),
      perEnv: Math.max(1, Number(factoryPerEnv.value) || 1),
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
      statusFor(`encoding corpus: ${scenarios.length} scenarios`);
      for (let si = 0; si < scenarios.length; si++) {
        const activeScenario = scenarios[si];
        if (!activeScenario) throw new Error(`scenario ${si} missing`);
        const totalFrames = Math.round(activeScenario.durationSec * activeScenario.fps);
        statusFor(
          `encoding ${activeScenario.id} (${si + 1}/${scenarios.length}): ${activeScenario.cameras.length} cameras x ${totalFrames} frames (${CAPTURE_WIDTH}x${CAPTURE_HEIGHT})`,
        );
        const startedUtc = new Date().toISOString();
        const result = await captureBatch({
          scenario: activeScenario,
          rig,
          scene,
          avatar,
          cell,
          onProgress: (p) => {
            statusFor(
              `scenario ${activeScenario.id}: ${p.camera} ${p.frame}/${p.totalFrames} (camera ${p.cameraIndex + 1}/${p.cameraTotal})`,
            );
          },
        });
        for (const clip of result.clips) {
          downloadBlob(clip.blob, `renders/${activeScenario.id}/${clip.camera}.mp4`);
        }
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
        totalClips += result.clips.length;
        statusFor(
          `saved ${activeScenario.id}: ${result.clips.length} clips + manifest (${si + 1}/${scenarios.length})`,
        );
      }
      statusFor(`saved renders/: ${scenarios.length} scenarios + ${totalClips} clips + manifests`);
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
      const plan = factoryPlan ?? readFactoryPlan();
      factoryPlan = plan;
      statusFor(
        `factory seed ${plan.rootSeed}: rendering ${plan.jobs.length} generated scenario(s)...`,
      );
      const results: FactoryCaptureResult[] = [];
      for (let ji = 0; ji < plan.jobs.length; ji++) {
        const job = plan.jobs[ji];
        if (!job) throw new Error(`factory job ${ji} missing`);
        const result = await renderFactoryJob(factoryWorld, job, {
          rootSeed: plan.rootSeed,
          onProgress: (p) => {
            statusFor(
              `${job.scenario.id}: ${p.camera} ${p.frame}/${p.totalFrames} (camera ${p.cameraIndex + 1}/${p.cameraTotal})`,
            );
          },
        });
        results.push(result);
        statusFor(`rendered ${job.scenario.id} (${ji + 1}/${plan.jobs.length})`);
      }
      statusFor(`exporting corpus ${plan.rootSeed}: ${results.length} scenario(s)...`);
      const summary = await saveCorpus(plan, results);
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
