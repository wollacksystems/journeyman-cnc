import type { ScenarioDef } from "./types";
import { atcJamScenario } from "./atc-jam";
import { sensorTripScenario } from "./sensor-trip";
import { wayLubeScenario } from "./way-lube";

/** Locked Phase 3 scenarios, in corpus/render order. */
export const scenarios: readonly ScenarioDef[] = [
  sensorTripScenario,
  wayLubeScenario,
  atcJamScenario,
];

export const scenarioById: ReadonlyMap<string, ScenarioDef> = new Map(
  scenarios.map((scenario) => [scenario.id, scenario]),
);
