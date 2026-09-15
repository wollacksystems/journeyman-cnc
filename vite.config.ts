import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
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
