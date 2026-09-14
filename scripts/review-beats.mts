/**
 * Beat-capture review harness: loads the rig, selects each scenario, waits to a
 * target sim time, and screenshots the 6-viewport composite so story beats can
 * be reviewed visually. Usage: node scripts/review-beats.mts (dev server on
 * :5181, e.g. `npm run dev -- --port 5181 --mode smoke`).
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = process.env.SMOKE_URL ?? "http://localhost:5181";
const OUT = "review";

interface Beat {
  scenario: string;
  /** Sim seconds to wait before the screenshot (scenario select resets t=0). */
  atSec: number;
  label: string;
}

// Key visual beats: failure states at full severity, plus the resolution.
const BEATS: readonly Beat[] = [
  { scenario: "sensor-trip", atSec: 15, label: "locate-red" },
  { scenario: "sensor-trip", atSec: 25, label: "wipe-dust" },
  { scenario: "sensor-trip", atSec: 45, label: "cleared-green" },
  { scenario: "way-lube", atSec: 15, label: "dry-axis" },
  { scenario: "way-lube", atSec: 27, label: "leak-full" },
  { scenario: "way-lube", atSec: 47, label: "lubed-green" },
  { scenario: "atc-jam", atSec: 5, label: "pre-jam" },
  { scenario: "atc-jam", atSec: 18, label: "jam-frozen" },
  { scenario: "atc-jam", atSec: 27, label: "jam-inspect" },
  { scenario: "atc-jam", atSec: 47, label: "cleared-green" },
];

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    timeout: 20_000,
    args: ["--enable-webgl", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const page = await context.newPage();
    await page.goto(BASE_URL, { waitUntil: "load", timeout: 60_000 });
    await page.locator("#rig").waitFor({ state: "visible", timeout: 20_000 });
    const select = page.locator("#scenario-select");

    for (const beat of BEATS) {
      await select.selectOption(beat.scenario); // change handler resets clock to 0
      await page.waitForTimeout(beat.atSec * 1000);
      const status = await page.locator("#capture-status").textContent();
      await page.screenshot({
        path: join(OUT, `${beat.scenario}__${beat.label}__t${beat.atSec}.png`),
      });
      console.log(
        `captured ${beat.scenario}/${beat.label} @t=${beat.atSec}s (status: ${status?.trim()})`,
      );
    }
    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
