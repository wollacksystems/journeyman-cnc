/**
 * Corpus content/scale measurement harness — supports the research ticket
 * "Corpus scale for a credible recall baseline". Headless (no WebGL): uses the
 * pure declaration layer only, so it costs milliseconds rather than a render.
 *
 * Plans a few corpus shapes and reports, per shape: planning cost, unique
 * narration strings, lesson pairs, and §3.7 chunk texts (the vocabulary
 * ceilings that cap how much knowledge a bigger corpus can buy). The measured
 * numbers and their reading live in the ingest-recall contract docs
 * (`docs/corpus-scale.md`); re-run this to re-derive them.
 *
 *   npm run measure:content
 */
import { planFactory } from "@/factory/plan.ts";

interface Shape {
  label: string;
  envCount: number;
  perEnv: number;
}

const SHAPES: readonly Shape[] = [
  { label: "v1 corpus (current)", envCount: 1, perEnv: 3 },
  { label: "4 envs", envCount: 4, perEnv: 3 },
  { label: "20 envs", envCount: 20, perEnv: 3 },
  { label: "67 envs", envCount: 67, perEnv: 3 },
  { label: "200 envs", envCount: 200, perEnv: 3 },
  { label: "1 env, all templates x4 slots (repeats)", envCount: 1, perEnv: 12 },
];

const SEED = 2026;

function count(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function unique(values: string[]): number {
  return new Set(values).size;
}

for (const shape of SHAPES) {
  const t0 = performance.now();
  const plan = planFactory(SEED, { envCount: shape.envCount, perEnv: shape.perEnv });
  const planMs = performance.now() - t0;

  const narration: string[] = [];
  const narrationByTemplate = new Map<string, string[]>();
  const lessonPairs: string[] = [];
  const lessonTitles: string[] = [];
  const beats = new Map<string, number>();
  const chunkTexts: string[] = [];
  let utteranceCount = 0;
  let beatCount = 0;
  let textBytes = 0;
  let minDur = Infinity;
  let maxDur = -Infinity;

  for (const job of plan.jobs) {
    const s = job.scenario;
    minDur = Math.min(minDur, s.durationSec);
    maxDur = Math.max(maxDur, s.durationSec);
    const lines = s.narration.map((n) => n.text);
    utteranceCount += lines.length;
    beatCount += s.beats.length;
    narration.push(...lines);
    const perTemplate = narrationByTemplate.get(s.templateId) ?? [];
    perTemplate.push(...lines);
    narrationByTemplate.set(s.templateId, perTemplate);
    lessonPairs.push(`${s.lesson.title}\u0000${s.lesson.body}`);
    lessonTitles.push(s.lesson.title);
    for (const b of s.beats) count(beats, b.id);
    for (const t of lines) chunkTexts.push(`${s.templateId}: ${t}`);
    for (const b of s.beats) {
      const inWindow = lines.join(" ");
      chunkTexts.push(`${s.templateId}: ${b.label}. ${inWindow}`);
    }
    chunkTexts.push(`${s.templateId}: ${s.lesson.title}. ${s.lesson.body}`);
    textBytes += lines.join(" ").length + s.lesson.title.length + s.lesson.body.length;
  }

  // Environments actually produced, and how much the cosmetic axes vary.
  const palettes = new Map<string, number>();
  const variants = new Map<string, number>();
  const rotations = new Map<string, number>();
  const atcSides = new Map<string, number>();
  for (const job of plan.jobs) {
    count(palettes, job.env.palette.name);
    count(variants, job.env.variant);
    count(rotations, String(Math.round((job.env.machineRotation * 180) / Math.PI)));
    count(atcSides, String(job.env.atcSide));
  }

  const captures = plan.jobs.length;
  const chunks = utteranceCount + beatCount + captures;
  console.log(
    JSON.stringify(
      {
        shape: shape.label,
        envs: plan.envCount,
        captures,
        planMs: Number(planMs.toFixed(1)),
        msPerCapture: Number((planMs / captures).toFixed(2)),
        utterances: utteranceCount,
        beats: beatCount,
        chunks,
        uniqueUtteranceTexts: unique(narration),
        uniqueUtteranceTextsPerTemplate: Object.fromEntries(
          [...narrationByTemplate].map(([k, v]) => [k, unique(v)]),
        ),
        uniqueLessonPairs: unique(lessonPairs),
        uniqueLessonTitles: unique(lessonTitles),
        uniqueChunkTexts: unique(chunkTexts),
        duplicateChunkRatio: Number((1 - unique(chunkTexts) / chunks).toFixed(3)),
        textBytes,
        durationSecRange: [Number(minDur.toFixed(2)), Number(maxDur.toFixed(2))],
        envAxes: {
          palettes: Object.fromEntries(palettes),
          variants: Object.fromEntries(variants),
          rotationsDeg: Object.fromEntries(rotations),
          atcSide: Object.fromEntries(atcSides),
        },
        beatIds: Object.fromEntries(beats),
      },
      null,
      1,
    ),
  );
}
