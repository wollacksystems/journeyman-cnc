/**
 * Corpus CLI (issue #8 §4, "ingest reader … + CLI listing mode"): inspect an
 * exported corpus from the shell — no UI, and the only repo imports are the
 * public barrel (`readCorpusIndex`, `iterTrainingTuples`,
 * `readScenarioScript`), which is exactly #9's "ingest loads a corpus using
 * only the public surface" criterion.
 *
 *   npm run corpus -- list   --root <dir-with-corpora/> --seed <n> [--json]
 *   npm run corpus -- tuples --root <dir-with-corpora/> --seed <n>
 *   npm run corpus -- verify --root <dir-with-corpora/> --seed <n>
 *
 * Index paths are project-root-relative (`corpora/<seed>/...`), so `--root`
 * is the directory those paths resolve against (the parent of `corpora/`).
 * Exit codes: 0 valid/empty result set, 1 invalid index or artifact
 * problem, 2 usage error.
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  corpusIndexPath,
  iterTrainingTuples,
  readCorpusIndex,
  readScenarioScript,
  type CorpusFilesystem,
} from "@/factory/index.ts";

interface CliOptions {
  command: "list" | "tuples" | "verify";
  root: string;
  seed: number;
  json: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions | null {
  const [command] = argv;
  if (command !== "list" && command !== "tuples" && command !== "verify") return null;
  let root: string | undefined;
  let seed: number | undefined;
  let json = false;
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--root") root = argv[++i];
    else if (flag === "--seed") seed = Number(argv[++i]);
    else if (flag === "--json") json = true;
    else return null;
  }
  if (!root || !Number.isInteger(seed)) return null;
  return { command, root: resolve(root), seed, json };
}

function usage(): never {
  console.error(
    "usage: node scripts/corpus.mts <list|tuples|verify> --root <dir-containing-corpora/> --seed <n> [--json]",
  );
  process.exit(2);
}

/** Node fs adapter for the reader's CorpusFilesystem port. */
function nodeFs(root: string): CorpusFilesystem {
  return {
    readFile: async (path) => await readFile(join(root, path), "utf8"),
  };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) usage();
  const { command, root, seed, json } = options;

  const validation = await readCorpusIndex(nodeFs(root), corpusIndexPath(seed));
  if (!validation.ok || validation.index === null) {
    console.error(`invalid corpus index for seed ${seed} under ${root}:`);
    for (const problem of validation.problems) {
      console.error(`  ${problem.at}: ${problem.message}`);
    }
    return 1;
  }
  const index = validation.index;

  if (command === "tuples") {
    for (const tuple of iterTrainingTuples(index)) {
      console.log(
        JSON.stringify({
          scenarioId: tuple.scenarioId,
          rootSeed: tuple.rootSeed,
          templateId: tuple.templateId,
          envId: tuple.env.envId,
          seed: tuple.seed,
          lesson: tuple.lesson,
          clips: tuple.clips,
          scriptPath: tuple.scriptPath,
          manifestPath: tuple.manifestPath,
        }),
      );
    }
    return 0;
  }

  if (command === "list") {
    if (json) {
      console.log(JSON.stringify({ ...index }, null, 2));
      return 0;
    }
    console.log(
      `corpus ${index.rootSeed} (engine ${index.engineVersion}, schema v${index.schemaVersion})`,
    );
    console.log(
      `plan: ${index.plan.envCount} env x ${index.plan.perEnv} scenarios = ${index.scenarios.length} total`,
    );
    for (const env of index.environments) {
      console.log(
        `  env ${env.envId} — ${env.variant}, ${env.palette}, rot ${env.machineRotation}rad, atc ${env.atcSide}, seed ${env.seed}`,
      );
      for (const scenarioId of env.scenarioIds) {
        const s = index.scenarios.find((entry) => entry.scenarioId === scenarioId);
        if (!s) continue;
        const cameras = Object.keys(s.clips).join(", ");
        console.log(`    ${s.scenarioId} [${s.templateId}] seed ${s.seed} — cameras: ${cameras}`);
        console.log(`      lesson: ${s.lesson.title}`);
        console.log(`      script: ${s.script}`);
        console.log(`      manifest: ${s.manifest}`);
      }
    }
    return 0;
  }

  // verify: index is valid; check every referenced artifact exists + is
  // non-empty, and that each script's provenance matches its tuple.
  let artifacts = 0;
  const problems: string[] = [];
  for (const tuple of iterTrainingTuples(index)) {
    const paths = [tuple.scriptPath, tuple.manifestPath, ...Object.values(tuple.clips)];
    for (const path of paths) {
      artifacts += 1;
      try {
        const info = await stat(join(root, path));
        if (!info.isFile() || info.size === 0) problems.push(`${path} (empty)`);
      } catch {
        problems.push(path);
      }
    }
    try {
      await readScenarioScript(nodeFs(root), tuple);
    } catch (error) {
      problems.push(`${tuple.scriptPath} (${String(error)})`);
    }
  }
  for (const spec of index.environments.map((env) => env.spec)) {
    artifacts += 1;
    try {
      const info = await stat(join(root, spec));
      if (!info.isFile() || info.size === 0) problems.push(`${spec} (empty)`);
    } catch {
      problems.push(spec);
    }
  }

  if (problems.length > 0) {
    console.error(`corpus ${index.rootSeed} INVALID — ${problems.length} artifact problem(s):`);
    for (const path of problems) console.error(`  ${path}`);
    return 1;
  }
  console.log(
    `corpus ${index.rootSeed} OK — ${index.scenarios.length} scenarios, ${artifacts} artifacts present and coherent`,
  );
  return 0;
}

process.exit(await main());
