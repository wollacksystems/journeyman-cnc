/**
 * Ingest reader for exported corpora (issues #8/#9): parse and validate a
 * corpus `index.json`, then stream typed training tuples across the whole
 * corpus without knowing the on-disk layout.
 *
 * Everything is DOM-free and headless-safe: file access is injected through
 * the tiny {@link CorpusFilesystem} port (Node `fs/promises` in scripts, a
 * fetch-backed adapter or in-memory map in the browser), so the same reader
 * validates freshly built indexes in verify:factory and reads real corpora
 * in an ingest pipeline.
 *
 * Validation is structural (a hand-rolled walker over the JSON — no schema
 * dependency in src/): schema + version gates, required fields, path
 * invariants, seed ranges, and id/xref consistency. Nothing here imports
 * WebGL or the capture stack; this module is part of the public layer.
 *
 * @module
 * @example
 * ```ts
 * import { nodeCorpusFilesystem } from "@/factory/corpus-read.ts"; // scripts only
 * ```
 * In scripts the filesystem port is `node:fs/promises`; in the browser it is
 * a fetch-backed adapter or an in-memory map. The full read flow:
 *
 * ```ts
 * import type { CorpusFilesystem } from "@/factory/corpus-read.ts";
 * import {
 *   iterTrainingTuples,
 *   readCorpusIndex,
 *   readScenarioScript,
 *   validateCorpusIndex,
 * } from "@/factory/corpus-read.ts";
 *
 * declare const fs: CorpusFilesystem;
 * declare const corpusRoot: string; // e.g. "corpora/0000002026"
 *
 * const validation = await readCorpusIndex(fs, `${corpusRoot}/index.json`);
 * if (!validation.ok || !validation.index) {
 *   throw new Error(`bad corpus: ${JSON.stringify(validation.problems)}`);
 * }
 * for (const tuple of iterTrainingTuples(validation.index)) {
 *   const script = await readScenarioScript(fs, tuple); // provenance-checked
 *   tuple.lesson.title;  // ground-truth label
 *   tuple.clips;         // camera -> clip path, relative to the corpus root
 * }
 * ```
 */

import type { CorpusIndex, CorpusIndexScenario, ScenarioScriptDoc } from "./corpus";

/**
 * Minimal filesystem port so the reader never touches Node or the DOM.
 * Paths are corpus-relative (exactly the `RelPath` values in the index).
 */
export interface CorpusFilesystem {
  /** Read a corpus-relative path to UTF-8 text; reject if missing. */
  readFile(path: string): Promise<string>;
}

/** One kind of reader validation failure, with the index path that failed. */
export interface CorpusProblem {
  /** Dotted path into the index document (e.g. `scenarios[3].seed`). */
  at: string;
  message: string;
}

/** Result of validating one `index.json` document. */
export interface CorpusValidation {
  ok: boolean;
  problems: CorpusProblem[];
  /** The parsed index — present only when the document was usable JSON. */
  index: CorpusIndex | null;
}

const SCHEMA = "journeyman-corpus-index";
const SCHEMA_VERSION = 1;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate an unparsed `index.json` payload. Rejects non-objects, wrong
 * schema/version, missing or malformed fields, paths that ignore the layout
 * invariants (absolute paths, backslashes, `..` escapes, wrong corpus-root
 * prefix), non-finite/negative seeds, and xref inconsistencies (env ids,
 * scenario order, per-env scenario lists, plan counts).
 *
 * @example
 * ```ts
 * import { validateCorpusIndex } from "@/factory/corpus-read.ts";
 *
 * const bad = validateCorpusIndex("not json");
 * bad.ok;          // false
 * bad.problems[0]; // { at: "$", message: "invalid JSON: ..." }
 * ```
 */
export function validateCorpusIndex(json: string): CorpusValidation {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      index: null,
      problems: [{ at: "$", message: `invalid JSON: ${String(error)}` }],
    };
  }
  if (!isObject(doc)) {
    return { ok: false, index: null, problems: [{ at: "$", message: "index is not an object" }] };
  }
  const problems: CorpusProblem[] = [];
  const need = (cond: boolean, at: string, message: string): void => {
    if (!cond) problems.push({ at, message });
  };

  need(doc["schema"] === SCHEMA, "schema", `expected "${SCHEMA}"`);
  need(doc["schemaVersion"] === SCHEMA_VERSION, "schemaVersion", "expected 1");
  const rootSeed = doc["rootSeed"];
  need(
    typeof rootSeed === "number" && Number.isInteger(rootSeed) && rootSeed >= 0,
    "rootSeed",
    "expected non-negative integer",
  );
  need(
    typeof doc["engineVersion"] === "string" && doc["engineVersion"].length > 0,
    "engineVersion",
    "expected non-empty string",
  );
  need(
    isObject(doc["plan"]) &&
      typeof doc["plan"]["envCount"] === "number" &&
      typeof doc["plan"]["perEnv"] === "number" &&
      doc["plan"]["envCount"] >= 1 &&
      doc["plan"]["perEnv"] >= 1,
    "plan",
    "expected { envCount >= 1, perEnv >= 1 }",
  );
  need(
    typeof doc["exportedUtc"] === "string" && !Number.isNaN(Date.parse(doc["exportedUtc"])),
    "exportedUtc",
    "expected ISO timestamp",
  );

  const environments = doc["environments"];
  const scenarios = doc["scenarios"];
  need(
    Array.isArray(environments) && environments.length >= 1,
    "environments",
    "expected non-empty array",
  );
  need(Array.isArray(scenarios) && scenarios.length >= 1, "scenarios", "expected non-empty array");
  if (!Array.isArray(environments) || !Array.isArray(scenarios)) {
    return { ok: problems.length === 0, problems, index: null };
  }

  // Environment entries + the corpus-root prefix for path invariants.
  const prefix = `corpora/${String(rootSeed).padStart(10, "0")}`;
  const envIds = new Set<string>();
  environments.forEach((env, i) => {
    const at = `environments[${i}]`;
    if (!isObject(env)) {
      problems.push({ at, message: "not an object" });
      return;
    }
    const id = env["envId"];
    need(typeof id === "string" && id.length > 0, `${at}.envId`, "expected non-empty string");
    if (typeof id === "string") {
      need(!envIds.has(id), `${at}.envId`, `duplicate environment id "${id}"`);
      envIds.add(id);
    }
    need(
      typeof env["seed"] === "number" && Number.isInteger(env["seed"]) && env["seed"] > 0,
      `${at}.seed`,
      "expected positive integer",
    );
    need(typeof env["variant"] === "string", `${at}.variant`, "expected string");
    need(env["atcSide"] === 1 || env["atcSide"] === -1, `${at}.atcSide`, "expected 1 or -1");
    need(typeof env["machineRotation"] === "number", `${at}.machineRotation`, "expected number");
    need(typeof env["palette"] === "string", `${at}.palette`, "expected string");
    need(
      typeof env["spec"] === "string" && validRelPath(env["spec"], `${prefix}/envs/`),
      `${at}.spec`,
      `expected path under ${prefix}/envs/`,
    );
    need(Array.isArray(env["scenarioIds"]), `${at}.scenarioIds`, "expected array");
  });
  if (envIds.size === 0) {
    return { ok: false, problems, index: null };
  }

  // Scenario entries: shape, path invariants, seed range, xrefs.
  const scenarioIds = new Set<string>();
  const perEnvScenarios = new Map<string, string[]>();
  scenarios.forEach((s, i) => {
    const at = `scenarios[${i}]`;
    if (!isObject(s)) {
      problems.push({ at, message: "not an object" });
      return;
    }
    const id = s["scenarioId"];
    need(typeof id === "string" && id.length > 0, `${at}.scenarioId`, "expected non-empty string");
    if (typeof id === "string") {
      need(!scenarioIds.has(id), `${at}.scenarioId`, `duplicate scenario id "${id}"`);
      scenarioIds.add(id);
    }
    const templateId = s["templateId"];
    need(
      typeof templateId === "string" && templateId.length > 0,
      `${at}.templateId`,
      "expected non-empty string",
    );
    const seed = s["seed"];
    need(
      typeof seed === "number" && Number.isInteger(seed) && seed > 0,
      `${at}.seed`,
      "expected positive integer",
    );
    need(
      isObject(s["lesson"]) &&
        typeof s["lesson"]["title"] === "string" &&
        typeof s["lesson"]["body"] === "string",
      `${at}.lesson`,
      "expected { title, body }",
    );

    const envId = s["envId"];
    need(
      typeof envId === "string" && envIds.has(envId),
      `${at}.envId`,
      `unknown environment "${String(envId)}"`,
    );
    if (typeof envId === "string" && envIds.has(envId)) {
      let list = perEnvScenarios.get(envId);
      if (!list) perEnvScenarios.set(envId, (list = []));
      if (typeof id === "string") list.push(id);
    }

    need(
      typeof s["script"] === "string" && validRelPath(s["script"], `${prefix}/scenarios/`),
      `${at}.script`,
      `expected path under ${prefix}/scenarios/`,
    );
    need(
      typeof s["manifest"] === "string" &&
        validRelPath(s["manifest"], `${prefix}/clips/`) &&
        s["manifest"] === `${prefix}/clips/${String(id)}/manifest.json`,
      `${at}.manifest`,
      "expected the scenario's clips/<id>/manifest.json path",
    );
    const clips = s["clips"];
    need(
      isObject(clips) && Object.keys(clips).length >= 1,
      `${at}.clips`,
      "expected non-empty camera map",
    );
    if (isObject(clips)) {
      for (const [camera, path] of Object.entries(clips)) {
        need(
          typeof path === "string" && path === `${prefix}/clips/${String(id)}/${camera}.mp4`,
          `${at}.clips.${camera}`,
          "expected clips/<id>/<camera>.mp4",
        );
      }
    }
  });

  // Cross-references: each env lists exactly its scenarios, in plan order.
  for (const env of environments) {
    if (!isObject(env)) continue;
    const envId = env["envId"];
    const listed = env["scenarioIds"];
    const actual = perEnvScenarios.get(envId as string) ?? [];
    need(
      Array.isArray(listed) &&
        listed.length === actual.length &&
        listed.every((v, i) => v === actual[i]),
      `environments[${environments.indexOf(env)}].scenarioIds`,
      "must list the environment's scenarios in plan order",
    );
  }
  const planEnv = isObject(doc["plan"]) ? doc["plan"] : null;
  const perEnv = planEnv === null ? 0 : Number(planEnv["perEnv"]);
  need(
    planEnv !== null &&
      environments.length === Number(planEnv["envCount"]) &&
      scenarios.length === environments.length * perEnv,
    "plan",
    "counts must match environments and scenarios arrays",
  );

  const index = problems.length === 0 ? (doc as unknown as CorpusIndex) : null;
  return { ok: problems.length === 0, problems, index };
}

/** Path invariant: relative, forward slashes, no `..`, under `prefix`
 * (callers pass prefixes that already end in `/`). */
function validRelPath(path: unknown, prefix: string): boolean {
  return (
    typeof path === "string" &&
    path.startsWith(prefix) &&
    !path.includes("\\") &&
    !path.includes("..") &&
    !path.startsWith("/")
  );
}

/** One fully-resolved training example: ground truth + media references. */
export interface TrainingTuple {
  /** Scenario id (stable recall identity: (rootSeed, scenarioId)). */
  scenarioId: string;
  /** Root seed of the corpus this tuple came from. */
  rootSeed: number;
  templateId: string;
  /** Environment summary (id, seed, variant, palette, rotation, ATC side). */
  env: CorpusIndex["environments"][number];
  /** Per-scenario sub-seed — regenerates the exact script. */
  seed: number;
  /** Ground-truth lesson labels. */
  lesson: { title: string; body: string };
  /** Camera -> clip path (relative to the corpus root). */
  clips: Record<string, string>;
  /** Paths of the script + capture manifest documents. */
  scriptPath: string;
  manifestPath: string;
}

/** Read + parse + validate a corpus index through the injected filesystem. */
export async function readCorpusIndex(
  fs: CorpusFilesystem,
  indexPath: string,
): Promise<CorpusValidation> {
  return validateCorpusIndex(await fs.readFile(indexPath));
}

/**
 * Stream every scenario of a validated corpus as {@link TrainingTuple}s, in
 * plan order. `fs` resolves the tuple's artifact paths on demand (scripts,
 * manifests, clip bytes) — the reader itself never touches disk.
 *
 * @example
 * ```ts
 * import { iterTrainingTuples, readCorpusIndex } from "@/factory/corpus-read.ts";
 * import type { CorpusFilesystem } from "@/factory/corpus-read.ts";
 *
 * declare const fs: CorpusFilesystem;
 * const { ok, index } = await readCorpusIndex(fs, "corpora/0000002026/index.json");
 * if (ok && index) {
 *   const tuples = [...iterTrainingTuples(index)];
 *   tuples.length;                     // one per scenario in the corpus
 *   tuples[0]!.templateId;             // e.g. "sensor-trip"
 *   tuples[0]!.lesson.title;           // ground-truth label for ingest
 * }
 * ```
 */
export function* iterTrainingTuples(index: CorpusIndex): Generator<TrainingTuple, void, void> {
  const envById = new Map(index.environments.map((e) => [e.envId, e]));
  for (const s of index.scenarios as readonly CorpusIndexScenario[]) {
    const env = envById.get(s.envId);
    if (!env) {
      // Unreachable for a validated index; throwing keeps the contract
      // self-enforcing for anyone iterating a hand-built document.
      throw new Error(`corpus index references unknown environment "${s.envId}"`);
    }
    yield {
      scenarioId: s.scenarioId,
      rootSeed: index.rootSeed,
      templateId: s.templateId,
      env,
      seed: s.seed,
      lesson: s.lesson,
      clips: { ...s.clips },
      scriptPath: s.script,
      manifestPath: s.manifest,
    };
  }
}

/**
 * Read one scenario's ground-truth script document and check it against the
 * tuple: the script's provenance (rootSeed, envId, seed, templateId) must
 * match what the index claims. Guards against tampered or cross-planted
 * script files — the index is validated, but artifacts on disk are not
 * trusted blindly.
 *
 * @throws When the script's provenance block disagrees with the tuple.
 * @example
 * ```ts
 * import { iterTrainingTuples, readScenarioScript } from "@/factory/corpus-read.ts";
 * import type { CorpusFilesystem } from "@/factory/corpus-read.ts";
 *
 * declare const fs: CorpusFilesystem;
 * declare const index: import("@/factory/corpus.ts").CorpusIndex;
 * for (const tuple of iterTrainingTuples(index)) {
 *   const script = await readScenarioScript(fs, tuple);
 *   script.lesson.body; // full ground-truth lesson text
 * }
 * ```
 */
export async function readScenarioScript(
  fs: CorpusFilesystem,
  tuple: TrainingTuple,
): Promise<ScenarioScriptDoc> {
  const doc = JSON.parse(await fs.readFile(tuple.scriptPath)) as ScenarioScriptDoc;
  const p = doc.provenance;
  const mismatches: string[] = [];
  if (p.rootSeed !== tuple.rootSeed) mismatches.push(`rootSeed ${p.rootSeed} != ${tuple.rootSeed}`);
  if (p.envId !== tuple.env.envId) mismatches.push(`envId ${p.envId} != ${tuple.env.envId}`);
  if (p.seed !== tuple.seed) mismatches.push(`seed ${p.seed} != ${tuple.seed}`);
  if (p.templateId !== tuple.templateId) {
    mismatches.push(`templateId ${p.templateId} != ${tuple.templateId}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`script provenance mismatch for ${tuple.scenarioId}: ${mismatches.join("; ")}`);
  }
  return doc;
}
