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

export default defineConfig({
  resolve: { alias: aliases },
  server: {
    watch: {
      // Review/beat captures write PNGs next to the sources; don't reload the
      // page (and reset sim time) every time a screenshot lands.
      ignored: ["**/review/**"],
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
