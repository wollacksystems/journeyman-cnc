import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

// Path aliases are declared once in tsconfig.json ("paths") and derived here
// so the two definitions cannot drift (issue #12). Vite does not read
// tsconfig paths natively; esbuild reads the same file automatically, so the
// bundle-based scripts need no extra flags.
type TsPaths = { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
const { compilerOptions } = JSON.parse(
  readFileSync(fileURLToPath(new URL("./tsconfig.json", import.meta.url)), "utf8"),
) as TsPaths;
const aliases = Object.entries(compilerOptions?.paths ?? {}).map(([key, targets]) => ({
  // "@/*" → prefix "@/"; "src/*" → root-relative dir "src/".
  find: key.replace(/\/\*$/, "/"),
  replacement: fileURLToPath(new URL(`./${targets[0]!.replace(/\*$/, "")}`, import.meta.url)),
}));

// A capture server is deliberately inert. `npm run footage -- capture` starts
// its own Vite with JOURNEYMAN_CAPTURE_SERVER=1 because a 1080p batch is tens of
// minutes of software-GL rendering, and *any* reload in that window throws the
// in-flight batch away and resets the sim clock. The ignore list below is a
// denylist, and a denylist loses: on 2026-09-24 an edit to this very file
// restarted the server mid-render and cost a two-hour run. An inert server
// watches nothing at all, so a shared checkout can keep editing sources,
// committing, and running the verify suites while the render grinds on.
const captureServer = process.env.JOURNEYMAN_CAPTURE_SERVER === "1";

export default defineConfig({
  resolve: { alias: aliases },
  server: {
    // HMR off as well: without a watcher there is nothing to push, and a
    // stale module graph is exactly what we want during a capture.
    hmr: !captureServer,
    watch: {
      // Capture flows write into the project while they run: review/beat PNGs
      // land next to the sources, the drivers persist downloads under
      // scripts/*-artifacts/, RENDER CORPUS writes renders/, and the verify
      // suites create and delete their esbuild bundles. A reload resets sim
      // time and abandons an in-flight batch (the page goes back to its "idle"
      // boot line), so none of these may be watched.
      ignored: captureServer
        ? ["**"]
        : [
            "**/review/**",
            "**/renders/**",
            "**/corpora/**",
            "**/scripts/smoke-artifacts/**",
            "**/scripts/footage-artifacts/**",
            "**/scripts/factory-artifacts/**",
            "**/*.bundle.mjs",
            "**/scripts/corpus.cli.mjs",
          ],
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        inspector: fileURLToPath(new URL("./inspector.html", import.meta.url)),
      },
    },
  },
});
