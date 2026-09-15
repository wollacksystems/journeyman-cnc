import { downloadBlob } from "../capture/batch";

/**
 * Gap between successive downloads. Chromium's multiple-download protection
 * cancels rapid programmatic download bursts (which a corpus export is), so
 * each artifact download is spaced out; the legacy render flow survives the
 * same way (bursts of 5 separated by minutes of rendering).
 */
const DOWNLOAD_GAP_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
import {
  buildCorpusIndex,
  buildScenarioScriptDoc,
  clipManifestPath,
  clipPath,
  corpusIndexPath,
  corpusJson,
  corpusRootPath,
  envSpecPath,
  scenarioScriptPath,
  type CorpusIndex,
} from "./corpus";
import type { FactoryPlan } from "./plan";
import type { FactoryCaptureResult } from "./render";

/**
 * Browser-side corpus writer: saves one planned corpus through the download
 * channel at the stable layout paths (see ./corpus). The index downloads
 * last, so an index.json on disk implies every referenced artifact was
 * written before it.
 */
export interface CorpusExportSummary {
  rootSeed: number;
  corpusRoot: string;
  /** Path the index was saved to (last artifact). */
  indexPath: string;
  scenarioCount: number;
  clipCount: number;
  /** The assembled index (caller can log/inspect it). */
  index: CorpusIndex;
}

export async function saveCorpus(
  plan: FactoryPlan,
  results: readonly FactoryCaptureResult[],
): Promise<CorpusExportSummary> {
  const rootSeed = plan.rootSeed;
  const clipsByScenario: Record<string, string[]> = {};

  // Footage + per-scenario capture manifests first (paths are computed from
  // the plan, never from browser download names). Each download is spaced
  // (DOWNLOAD_GAP_MS) so the browser never cancels the burst.
  for (const result of results) {
    const scenarioId = result.job.scenario.id;
    const cameras: string[] = [];
    for (const clip of result.clips) {
      cameras.push(clip.camera);
      downloadBlob(clip.blob, clipPath(rootSeed, scenarioId, clip.camera));
      await sleep(DOWNLOAD_GAP_MS);
    }
    downloadBlob(
      new Blob([corpusJson(result.manifest)], { type: "application/json" }),
      clipManifestPath(rootSeed, scenarioId),
    );
    await sleep(DOWNLOAD_GAP_MS);
    clipsByScenario[scenarioId] = cameras;
  }

  // Environment specs (once per environment, not per job) + scenario scripts
  // (ground truth).
  const specJobs = new Map<string, FactoryPlan["jobs"][number]>();
  for (const job of plan.jobs) {
    if (!specJobs.has(job.env.id)) specJobs.set(job.env.id, job);
    downloadBlob(
      new Blob([corpusJson(buildScenarioScriptDoc(job, rootSeed))], { type: "application/json" }),
      scenarioScriptPath(rootSeed, job.scenario.id),
    );
    await sleep(DOWNLOAD_GAP_MS);
  }
  for (const job of specJobs.values()) {
    downloadBlob(
      new Blob([corpusJson(job.env)], { type: "application/json" }),
      envSpecPath(rootSeed, job.env.id),
    );
    await sleep(DOWNLOAD_GAP_MS);
  }

  // Index last: its presence on disk certifies the corpus is complete.
  const index = buildCorpusIndex({
    plan,
    clipsByScenario,
    exportedUtc: new Date().toISOString(),
  });
  downloadBlob(
    new Blob([corpusJson(index)], { type: "application/json" }),
    corpusIndexPath(rootSeed),
  );

  return {
    rootSeed,
    corpusRoot: corpusRootPath(rootSeed),
    indexPath: corpusIndexPath(rootSeed),
    scenarioCount: results.length,
    clipCount: results.reduce((n, r) => n + r.clips.length, 0),
    index,
  };
}
