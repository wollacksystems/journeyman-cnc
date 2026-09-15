import type { ScenarioDef } from "./types";

/**
 * Way-lube starvation scenario: a leaking or empty metering line leaves the
 * guideway dry, creating a visible film and rough axis motion. Locked 50 s.
 */
export const wayLubeScenario: ScenarioDef = {
  id: "way-lube",
  title: "Way-lube failure: dry guideway and leaking metering line",
  role: "CNC machinist diagnosing a dry slideway and way-lube leak",
  durationSec: 50,
  fps: 30,
  cameras: ["side-a", "side-b", "head", "chest"],
  beats: [
    {
      id: "walk_up",
      label: "Walk up to the machine",
      tStart: 0,
      tEnd: 10,
      cameraHint: "side-a",
      motion: {
        pose: "walk",
        walkFrom: [0, 3.2] as const,
        walkTo: [0, 1.15] as const,
        look: [0, 1.2, -1] as const,
      },
    },
    {
      id: "listen_axis",
      label: "Listen for a dry slideway",
      tStart: 10,
      tEnd: 20,
      cameraHint: "head",
      motion: {
        pose: "stand",
        standAt: [0, 1.15] as const,
        lean: 0.16,
        look: [0, 1.45, -1.7] as const,
      },
    },
    {
      id: "inspect_leak",
      label: "Inspect the way-lube metering line",
      tStart: 20,
      tEnd: 32,
      cameraHint: "chest",
      motion: {
        pose: "wipe",
        standAt: [0.2, 0.8] as const,
        lean: 0.38,
        reach: { hand: "left", target: [-0.3, 1.0, 0.25] as const },
        look: [-0.3, 1.0, 0.25] as const,
      },
    },
    {
      id: "prime_lube",
      label: "Prime the metering pump",
      tStart: 32,
      tEnd: 42,
      cameraHint: "head",
      motion: {
        pose: "stand",
        standAt: [0.1, 0.85] as const,
        lean: 0.25,
        reach: { hand: "right", target: [-0.3, 1.0, 0.3] as const },
        look: [-0.3, 1.0, 0.25] as const,
      },
    },
    {
      id: "verify_motion",
      label: "Verify a clean, lubricated move",
      tStart: 42,
      tEnd: 50,
      cameraHint: "side-a",
      motion: { pose: "stand", standAt: [0, 0.95] as const, look: [0, 1.05, -1.6] as const },
    },
  ],
  narration: [
    {
      t: 2,
      text: "The axis sounds dry after warm-up. I am checking lubrication before I chase servo or ball-screw faults.",
    },
    {
      t: 12,
      text: "A dry slideway has a sharp stick-slip sound and a hotter-than-normal guide surface.",
    },
    {
      t: 23,
      text: "The metering line is wet at the fitting but the guideway is dry. That points to a leak, not a tuning problem.",
    },
    {
      t: 34,
      text: "Replace the damaged line, fill the reservoir, and prime the pump until oil reaches the guideway.",
    },
    {
      t: 44,
      text: "Run a slow test move. Smooth travel and a thin even film confirm the lubrication circuit is working.",
    },
  ],
  lesson: {
    title: "A dry slideway points to a way-lube delivery problem before a servo fault",
    body: "When an axis develops stick-slip or a sharp dry sound after warm-up, inspect the way-lube reservoir, metering line, fittings, and pump before changing servo tuning. A wet fitting with a dry guideway indicates a leaking or blocked delivery line. Repair the line, refill and prime the pump, then verify with a slow test move and a thin even oil film.",
  },
  cell: {
    dust: null,
    wayLube: { appearsAt: 20, clearedAt: 40 },
    atc: null,
    signals: [
      { tStart: 0, red: 0, amber: 1, green: 0 },
      { tStart: 40, red: 0, amber: 0, green: 1 },
    ],
  },
};
