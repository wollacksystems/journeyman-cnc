/** Headless deterministic proof for the complete Phase 3 scenario registry. */
import { readFileSync } from "node:fs";
import { scenarios } from "@/scenario/registry.ts";
import { driveScenario } from "@/scenario/drive.ts";
import { validateScenario } from "@/scenario/types.ts";

type Fixture = {
  scenarioId: string;
  durationSec: number;
  fps: number;
  cameras: string[];
  beats: Array<{ id: string; tStart: number; tEnd: number; cameraHint: string }>;
  narration: Array<{ t: number; text: string }>;
  lesson: { title: string; body: string };
};

let failures = 0;
function check(name: string, condition: boolean, detail: string): void {
  if (condition) console.log(`[PASS] ${name}: ${detail}`);
  else {
    failures += 1;
    console.error(`[FAIL] ${name}: ${detail}`);
  }
}

check(
  "registry has locked corpus",
  scenarios.length === 3 &&
    scenarios.map((scenario) => scenario.id).join(",") === "sensor-trip,way-lube,atc-jam",
  scenarios.map((scenario) => scenario.id).join(","),
);

for (const scenario of scenarios) {
  const problems = validateScenario(scenario);
  check(`${scenario.id} validates`, problems.length === 0, problems.join("; ") || "zero problems");
  check(
    `${scenario.id} is stretched`,
    scenario.durationSec >= 45 && scenario.durationSec <= 60,
    `${scenario.durationSec}s at ${scenario.fps} fps (${Math.round(scenario.durationSec * scenario.fps)} frames)`,
  );
  check(
    `${scenario.id} has production cameras`,
    scenario.cameras.length === 4 && scenario.cameras.join(",") === "side-a,side-b,head,chest",
    scenario.cameras.join(","),
  );

  const fixture = JSON.parse(readFileSync(`fixtures/${scenario.id}.json`, "utf8")) as Fixture;
  check(`${scenario.id} fixture identity`, fixture.scenarioId === scenario.id, fixture.scenarioId);
  check(
    `${scenario.id} fixture timeline shape`,
    fixture.durationSec === scenario.durationSec &&
      fixture.fps === scenario.fps &&
      fixture.beats.length === scenario.beats.length &&
      fixture.narration.length > 0 &&
      fixture.lesson.title.length > 0 &&
      fixture.lesson.body.length > 0,
    `${fixture.beats.length} beats, ${fixture.narration.length} narration lines`,
  );
}

const sensorBefore = driveScenario(scenarios[0]!, 20).cell.dust;
const sensorAfter = driveScenario(scenarios[0]!, 39.5).cell.dust;
check(
  "sensor-trip dust transition",
  sensorBefore === 1 && sensorAfter === 0,
  `${sensorBefore} -> ${sensorAfter}`,
);

const lubeBefore = driveScenario(scenarios[1]!, 18).cell.wayLube;
const lubeDuring = driveScenario(scenarios[1]!, 25).cell.wayLube;
const lubeAfter = driveScenario(scenarios[1]!, 45).cell.wayLube;
check(
  "way-lube transition",
  lubeBefore === 0 && lubeDuring > 0 && lubeAfter === 0,
  `${lubeBefore} -> ${lubeDuring} -> ${lubeAfter}`,
);

const atcBefore = driveScenario(scenarios[2]!, 9).cell.atcRotation;
const atcJam = driveScenario(scenarios[2]!, 25).cell;
const atcAfter = driveScenario(scenarios[2]!, 45).cell;
check(
  "ATC jam freezes carousel",
  atcJam.atcJammed === 1 &&
    atcJam.atcRotation === 18 &&
    atcAfter.atcJammed === 0 &&
    atcAfter.atcRotation !== atcBefore,
  `pre=${atcBefore.toFixed(2)} jam=${atcJam.atcRotation.toFixed(2)} post=${atcAfter.atcRotation.toFixed(2)}`,
);

console.log(`\n${failures === 0 ? "ALL PHASE 3 CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
