/**
 * Narration + lesson banks for the scenario generator.
 *
 * First-person, locked-corpus voice: each field offers several phrasings of
 * the same instructional content and the generator picks per scenario seed,
 * so generated corpora vary in wording while preserving ground-truth meaning
 * for the ingest pipeline.
 */
export interface SensorTripBank {
  open: string[];
  locate: string[];
  found: string[];
  wipe: string[];
  verify: string[];
  clear: string[];
  lessonTitles: string[];
  lessonBodies: string[];
}

export interface WayLubeBank {
  open: string[];
  listen: string[];
  inspect: string[];
  prime: string[];
  verify: string[];
  lessonTitles: string[];
  lessonBodies: string[];
}

export interface AtcJamBank {
  open: string[];
  observe: string[];
  inspect: string[];
  clear: string[];
  verify: string[];
  lessonTitles: string[];
  lessonBodies: string[];
}

export const SENSOR_TRIP_BANK: SensorTripBank = {
  open: [
    "X axis dropped into overtravel on a warm start. I check the guard-door proximity switch first.",
    "Overtravel on a warm start with no move commanded. Guard-door sensor gets checked before anything else.",
    "The control flags overtravel before the spindle ever spins. First suspect is the door interlock switch.",
  ],
  locate: [
    "I start with the protective circuit, not the limit switch. Follow the door interlock to the sensor face.",
    "Protective circuit before limit switch: I follow the door interlock chain out to the sensor face.",
    "Before touching the limit switch I walk the protective circuit out to the door sensor itself.",
  ],
  found: [
    "There it is. Dust bridged across the sensor, so the controller reads the axis at its limit.",
    "Found it: fine dust bridged the sensor face, so the controller reads the door as blocked.",
    "That's the fault — a dust bridge across the sensor is holding the door circuit closed.",
  ],
  wipe: [
    "A rag is enough. Wipe it clean and keep the bracket square to the door.",
    "No parts needed. A rag across the sensor face and the bracket stays square to the door.",
    "A shop rag clears it. Wipe the face, keep the bracket square, don't knock the alignment.",
  ],
  verify: [
    "Back off and re-home. The stack should move from red to amber before the final clear.",
    "Step back out and re-home. Watch the stack: red to amber, then the final clear.",
    "Backing off to re-home now. The signal stack should step red, then amber, then green.",
  ],
  clear: [
    "Alarm's clear. Same cause every few months. Clean it, don't replace it.",
    "Cleared. This one comes back every few months — cleaning beats replacing here.",
    "Alarm clear again. Recurring dust, same fix every time: clean it, don't replace it.",
  ],
  lessonTitles: [
    "A false X-axis overtravel alarm is often a dust-bridged interlock sensor",
    "Warm-start overtravel points at the guard-door sensor before the limit switch",
  ],
  lessonBodies: [
    "Symptom: the axis drops into overtravel right on a warm start, before any move. Root cause: a protective proximity/interlock switch on the guard door gets bridged by fine dust, so the controller reads the door or axis as at its limit. Fix: check the protective switch before replacing a limit switch; wipe the sensor face clean and confirm the bracket is square to the door. Verify by backing off and re-homing; the signal stack kicks amber to green the moment the door reads clear. Recurring cells see this every few months; include a sensor wipe in preventive maintenance and clean before replace.",
    "A warm-start overtravel with no commanded move is rarely a failed limit switch. The guard-door interlock sensor bridges with fine dust and reads as at-limit. Inspect and wipe the sensor face, keep the bracket square, then re-home and watch the stack step amber to green. Schedule the wipe into preventive maintenance for dusty cells.",
  ],
};

/**
 * Way-lube starvation: dry slideway -> leaking metering line -> repair +
 * prime + verify. Ground truth mirrors the locked way-lube scenario.
 */
export const WAY_LUBE_BANK: WayLubeBank = {
  open: [
    "The axis sounds dry after warm-up. I am checking lubrication before I chase servo or ball-screw faults.",
    "Stick-slip after warm-up. Lube circuit first — servo faults come later, if at all.",
    "That dry axis sound right after warm-up points at lubrication, not the servo loop.",
  ],
  listen: [
    "A dry slideway has a sharp stick-slip sound and a hotter-than-normal guide surface.",
    "Listen: sharp stick-slip, and the guide is running hot. Classic starved slideway.",
    "That's the stick-slip signature, with more heat on the guide than the job justifies.",
  ],
  inspect: [
    "The metering line is wet at the fitting but the guideway is dry. That points to a leak, not a tuning problem.",
    "Wet fitting, dry guideway — the delivery line is leaking or blocked, not the tuning.",
    "Oil at the fitting but nothing reaching the way: the metering line is the problem.",
  ],
  prime: [
    "Replace the damaged line, fill the reservoir, and prime the pump until oil reaches the guideway.",
    "New line in, reservoir filled, and I prime until film shows on the guideway.",
    "Repair the line, top up the reservoir, and keep priming until the way runs wet.",
  ],
  verify: [
    "Run a slow test move. Smooth travel and a thin even film confirm the lubrication circuit is working.",
    "Slow test move now: smooth travel plus a thin even film means the circuit is healthy.",
    "A slow pass tells the story — smooth travel, even film, lube circuit confirmed.",
  ],
  lessonTitles: [
    "A dry slideway points to a way-lube delivery problem before a servo fault",
    "Stick-slip after warm-up: check the lube circuit before touching servo tuning",
  ],
  lessonBodies: [
    "When an axis develops stick-slip or a sharp dry sound after warm-up, inspect the way-lube reservoir, metering line, fittings, and pump before changing servo tuning. A wet fitting with a dry guideway indicates a leaking or blocked delivery line. Repair the line, refill and prime the pump, then verify with a slow test move and a thin even oil film.",
    "Sharp stick-slip and a hot guideway after warm-up mean lubrication starvation until proven otherwise. A metering fitting that is wet while the way is dry isolates the fault to the delivery line. Replace the line, refill and prime the pump, and confirm with a slow test move leaving a thin even film on the guideway before resuming production.",
  ],
};

/**
 * ATC indexing jam: carousel stopped between pockets -> mechanical inspection
 * -> clear + reset + verify. Ground truth mirrors the locked atc-jam scenario.
 */
export const ATC_JAM_BANK: AtcJamBank = {
  open: [
    "The control stopped during a tool change. I am treating this as an ATC index problem until the carousel proves otherwise.",
    "Tool-change alarm mid-cycle. Working assumption: ATC index fault until proven otherwise.",
    "The changer hung up during an index. I start from the mechanical side, not the control side.",
  ],
  observe: [
    "The carousel is between pockets, so do not force the spindle or cycle the changer repeatedly.",
    "Stopped between pockets. No forcing the spindle, no repeated cycling from here.",
    "Carousel hanging mid-index: hands off the cycle button, nothing gets forced.",
  ],
  inspect: [
    "A loose tool or chip in the pocket can stop the index. I inspect the pocket and the release path before resetting.",
    "Check the active pocket first: a loose tool or chip wedged there will stop the index cold.",
    "Pockets jam on loose tools and chip buildup. Pocket and release path get inspected before any reset.",
  ],
  clear: [
    "Clear the obstruction, confirm the pocket is seated, then reset the changer with the machine in a safe state.",
    "Obstruction out, pocket confirmed seated, and the reset happens in a safe state only.",
    "Clear it, seat the pocket, reset the changer — safe state first, always.",
  ],
  verify: [
    "The next index completes cleanly. The jam was mechanical interference, not a bad control parameter.",
    "One clean index on the reset. Mechanical interference it was — no parameter to chase.",
    "Next change runs through clean, which confirms it: mechanical interference, not a control fault.",
  ],
  lessonTitles: [
    "An ATC index jam should be inspected mechanically before repeated resets",
    "A carousel stopped between pockets means mechanical inspection before cycling",
  ],
  lessonBodies: [
    "When an automatic tool changer stops between pockets, stop cycling it and inspect the active pocket, tool retention, chip buildup, release path, and carousel seating. Clear the obstruction only in a safe state, confirm the pocket is seated, reset the changer, and verify one complete tool change before returning to production.",
    "An ATC stopped mid-index is a mechanical fault until proven otherwise: inspect the active pocket, retention, chips, and release path instead of cycling the changer. Clear obstructions in a safe state, confirm pocket seating, reset once, and verify a full clean tool change before returning to production.",
  ],
};
