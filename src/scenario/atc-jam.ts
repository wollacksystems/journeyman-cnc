import type { ScenarioDef } from "./types";

/**
 * ATC jam scenario: the carousel stops mid-index, the machinist inspects the
 * pocket, clears the obstruction, and verifies a successful tool change.
 */
export const atcJamScenario: ScenarioDef = {
  id: "atc-jam",
  title: "ATC jam: carousel stopped between tool pockets",
  role: "CNC machinist clearing an automatic tool changer indexing jam",
  durationSec: 50,
  fps: 30,
  cameras: ["side-a", "side-b", "head", "chest"],
  beats: [
    {
      id: "walk_up",
      label: "Walk up after the tool-change alarm",
      tStart: 0,
      tEnd: 10,
      cameraHint: "side-a",
      motion: {
        pose: "walk",
        walkFrom: [0, 3.2] as const,
        walkTo: [1.15, 0.95] as const,
        look: [2.1, 1.35, -1] as const,
      },
    },
    {
      id: "observe_atc",
      label: "Observe the stopped carousel",
      tStart: 10,
      tEnd: 20,
      cameraHint: "head",
      motion: {
        pose: "stand",
        standAt: [1.15, 0.95] as const,
        lean: 0.12,
        look: [2.1, 1.25, -1] as const,
      },
    },
    {
      id: "inspect_pocket",
      label: "Inspect the jammed tool pocket",
      tStart: 20,
      tEnd: 32,
      cameraHint: "chest",
      motion: {
        pose: "wipe",
        standAt: [1.7, 0.35] as const,
        lean: 0.34,
        reach: { hand: "right", target: [1.85, 1.26, -0.7] as const },
        look: [1.9, 1.25, -0.85] as const,
      },
    },
    {
      id: "clear_jam",
      label: "Clear the obstruction and reset",
      tStart: 32,
      tEnd: 42,
      cameraHint: "head",
      motion: {
        pose: "stand",
        standAt: [1.7, 0.35] as const,
        lean: 0.22,
        reach: { hand: "left", target: [1.85, 1.26, -0.7] as const },
        look: [1.9, 1.25, -0.85] as const,
      },
    },
    {
      id: "verify_change",
      label: "Verify the next tool change",
      tStart: 42,
      tEnd: 50,
      cameraHint: "side-b",
      motion: { pose: "stand", standAt: [1.1, 0.95] as const, look: [2.1, 1.25, -1] as const },
    },
  ],
  narration: [
    {
      t: 2,
      text: "The control stopped during a tool change. I am treating this as an ATC index problem until the carousel proves otherwise.",
    },
    {
      t: 12,
      text: "The carousel is between pockets, so do not force the spindle or cycle the changer repeatedly.",
    },
    {
      t: 23,
      text: "A loose tool or chip in the pocket can stop the index. I inspect the pocket and the release path before resetting.",
    },
    {
      t: 35,
      text: "Clear the obstruction, confirm the pocket is seated, then reset the changer with the machine in a safe state.",
    },
    {
      t: 44,
      text: "The next index completes cleanly. The jam was mechanical interference, not a bad control parameter.",
    },
  ],
  lesson: {
    title: "An ATC index jam should be inspected mechanically before repeated resets",
    body: "When an automatic tool changer stops between pockets, stop cycling it and inspect the active pocket, tool retention, chip buildup, release path, and carousel seating. Clear the obstruction only in a safe state, confirm the pocket is seated, reset the changer, and verify one complete tool change before returning to production.",
  },
  cell: {
    dust: null,
    wayLube: null,
    atc: { appearsAt: 10, clearedAt: 40 },
    signals: [
      { tStart: 0, red: 0, amber: 1, green: 0 },
      { tStart: 10, red: 1, amber: 0, green: 0 },
      { tStart: 40, red: 0, amber: 0, green: 1 },
    ],
  },
};
