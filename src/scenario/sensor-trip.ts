import type { ScenarioDef } from "./types";

/**
 * False overtravel alarm scenario (20 s Phase 2 smoke; Phase 3 stretches the
 * same beats to the locked 45-60 s durations).
 *
 * Story: an expert walks up to a CNC cell after a warm start, finds the X axis
 * dropped into overtravel, locates the guard-door proximity/interlock switch
 * bridged by dust, wipes it clean, re-homes, and confirms the amber-to-green
 * clear on the signal stack.
 */
export const sensorTripScenario: ScenarioDef = {
  id: "sensor-trip",
  title: "False overtravel alarm: dust-bridged guard-door sensor",
  role: "CNC machinist troubleshooting a false X-axis overtravel alarm",
  durationSec: 20,
  fps: 30,
  cameras: ["side-a", "side-b", "head", "chest"],
  beats: [
    {
      id: "walk_up",
      label: "Walk up to the cell",
      tStart: 0,
      tEnd: 4,
      cameraHint: "side-a",
      motion: {
        pose: "walk",
        walkFrom: [0, 3.2] as const,
        walkTo: [0, 1.1] as const,
        look: [0, 1.3, -0.5] as const,
      },
    },
    {
      id: "locate_sensor",
      label: "Locate the guard-door sensor",
      tStart: 4,
      tEnd: 8,
      cameraHint: "head",
      motion: {
        pose: "stand",
        standAt: [0, 1.1] as const,
        lean: 0.25,
        look: [0.35, 1.05, 0.25] as const,
      },
    },
    {
      id: "wipe_sensor",
      label: "Step in and wipe the sensor clean",
      tStart: 8,
      tEnd: 13,
      cameraHint: "head",
      motion: {
        pose: "wipe",
        standAt: [0.15, 0.72] as const,
        lean: 0.45,
        reach: {
          hand: "right",
          target: [0.42, 1.02, 0.4] as const,
        },
        look: [0.35, 1.02, 0.2] as const,
      },
    },
    {
      id: "verify_clear",
      label: "Back off and verify the sensor clears",
      tStart: 13,
      tEnd: 16,
      cameraHint: "chest",
      motion: {
        pose: "stand",
        standAt: [0, 0.95] as const,
        lean: 0.12,
        look: [0.35, 1.05, 0.15] as const,
      },
    },
    {
      id: "alarm_clear",
      label: "Signal stack confirms amber-to-green",
      tStart: 16,
      tEnd: 20,
      cameraHint: "side-a",
      motion: {
        pose: "stand",
        standAt: [0, 0.95] as const,
        look: [-4.6, 2.5, -4.3] as const,
      },
    },
  ],
  narration: [
    {
      t: 1,
      text: "X axis dropped into overtravel on a warm start. I check the guard-door proximity switch first.",
    },
    { t: 4.5, text: "There it is. Dust bridged across the sensor, so the controller reads the axis at its limit." },
    { t: 7.5, text: "A rag is enough. Wipe it clean, bracket square to the door." },
    { t: 12.5, text: "Back off and re-home. Watch the stack kick amber to green the moment the door reads clear." },
    { t: 16, text: "Alarm's clear. Same cause every few months. Clean it, don't replace it." },
  ],
  lesson: {
    title: "A false X-axis overtravel alarm is often a dust-bridged interlock sensor",
    body: "Symptom: the axis drops into overtravel right on a warm start, before any move. Root cause: a protective proximity/interlock switch on the guard door gets bridged by fine dust, so the controller reads the door or axis as at its limit. Fix: check the protective switch before replacing a limit switch; wipe the sensor face clean and confirm the bracket is square to the door. Verify by backing off and re-homing; the signal stack kicks amber to green the moment the door reads clear. Recurring cells see this every few months; include a sensor wipe in preventive maintenance and clean before replace.",
  },
  cell: {
    dust: { appearsAt: 4, clearedAt: 12.5 },
    signals: [
      { tStart: 0, red: 1, amber: 0, green: 0 },
      { tStart: 12.5, red: 0, amber: 1, green: 0 },
      { tStart: 14, red: 0, amber: 0, green: 1 },
    ],
  },
};