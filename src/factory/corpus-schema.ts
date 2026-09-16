/**
 * JSON Schema (draft 2020-12) for the corpus `index.json` — issue #9's
 * schema milestone, exported as data so tools and scripts can reuse it
 * (`corpusIndexJsonSchema`, serialized to `schemas/*.json` by the verify
 * suite, which also keeps this declaration and the reader from drifting).
 *
 * Derivation note (Zod): this declaration mirrors the reader's structural
 * walker in `corpus-read.ts` by hand today. If hand-maintaining both sides
 * starts to hurt, the intended migration is to declare the schema once in
 * Zod and derive both artifacts from it — `zodToJsonSchema` for this file
 * and `z.infer<...>` for the reader's `CorpusIndex` typing — keeping the
 * walker as a fallback or replacing it with `schema.parse`. The verify
 * suite's drift check is what makes either path safe: it pins this schema
 * against generated fixtures AND against the reader, so a Zod migration
 * cannot silently change the contract.
 *
 * @module
 * @example
 * ```ts
 * import { corpusIndexJsonSchema } from "@/factory/corpus-schema.ts";
 *
 * corpusIndexJsonSchema.$id;      // "https://wollacksystems.dev/schemas/..."
 * corpusIndexJsonSchema.required; // fields every index.json must carry
 *
 * // The verify suite serializes it (byte-stable) for external tools:
 * //   writeFileSync("schemas/journeyman-corpus-index.v1.json", corpusJson(corpusIndexJsonSchema))
 * ```
 */

export const corpusIndexJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://wollacksystems.dev/schemas/journeyman-corpus-index.v1.json",
  title: "Journeyman corpus index",
  description:
    "Ingest entry point of an exported journeyman-sim factory corpus (corpora/<rootSeed-padded-10>/index.json). Everything downstream needs (grouping, recall keys, replay) is reachable from this document.",
  type: "object",
  required: [
    "schema",
    "schemaVersion",
    "rootSeed",
    "engineVersion",
    "plan",
    "exportedUtc",
    "environments",
    "scenarios",
  ],
  additionalProperties: false,
  properties: {
    schema: { const: "journeyman-corpus-index" },
    schemaVersion: { const: 1 },
    rootSeed: { type: "integer", minimum: 0 },
    engineVersion: { type: "string", minLength: 1 },
    plan: {
      type: "object",
      required: ["envCount", "perEnv"],
      additionalProperties: false,
      properties: {
        envCount: { type: "integer", minimum: 1 },
        perEnv: { type: "integer", minimum: 1 },
      },
    },
    exportedUtc: { type: "string", format: "date-time" },
    environments: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: [
          "envId",
          "seed",
          "variant",
          "machineRotation",
          "atcSide",
          "palette",
          "spec",
          "scenarioIds",
        ],
        additionalProperties: false,
        properties: {
          envId: { type: "string", minLength: 1 },
          seed: { type: "integer", minimum: 1 },
          variant: { type: "string" },
          machineRotation: { type: "number" },
          atcSide: { enum: [1, -1] },
          palette: { type: "string" },
          spec: { $ref: "#/$defs/envSpecPath" },
          scenarioIds: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "Scenario ids generated in this environment, in plan order.",
          },
        },
      },
    },
    scenarios: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: [
          "scenarioId",
          "templateId",
          "envId",
          "seed",
          "lesson",
          "script",
          "manifest",
          "clips",
        ],
        additionalProperties: false,
        properties: {
          scenarioId: { type: "string", minLength: 1 },
          templateId: { type: "string", minLength: 1 },
          envId: { type: "string", minLength: 1 },
          seed: { type: "integer", minimum: 1 },
          lesson: {
            type: "object",
            required: ["title", "body"],
            additionalProperties: false,
            properties: {
              title: { type: "string", minLength: 1 },
              body: { type: "string", minLength: 1 },
            },
          },
          script: { $ref: "#/$defs/scenarioScriptPath" },
          manifest: { $ref: "#/$defs/clipManifestPath" },
          clips: {
            type: "object",
            minProperties: 1,
            additionalProperties: { $ref: "#/$defs/clipPath" },
          },
        },
      },
    },
  },
  $defs: {
    corpusRoot: {
      type: "string",
      pattern: "^corpora/[0-9]{10}$",
      description: "corpora/<rootSeed padded to 10 digits> — lexical order equals numeric order.",
    },
    relPath: {
      type: "string",
      pattern: "^[^\\\\]*$",
      description: "POSIX-style relative path; backslashes are never valid.",
    },
    envSpecPath: {
      type: "string",
      pattern: "^corpora/[0-9]{10}/envs/[A-Za-z0-9_-]+\\.json$",
    },
    scenarioScriptPath: {
      type: "string",
      pattern: "^corpora/[0-9]{10}/scenarios/[A-Za-z0-9_-]+\\.json$",
    },
    clipManifestPath: {
      type: "string",
      pattern: "^corpora/[0-9]{10}/clips/[A-Za-z0-9_-]+/manifest\\.json$",
    },
    clipPath: {
      type: "string",
      pattern: "^corpora/[0-9]{10}/clips/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+\\.mp4$",
    },
  },
} as const;
