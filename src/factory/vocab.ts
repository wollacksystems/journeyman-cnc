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
