import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const data = fileURLToPath(new URL("./data/", import.meta.url));

/**
 * Ships each demo repository's license text, copied by site-data.mjs, as
 * data/<id>.LICENSE.txt next to the demo that describes its code.
 */
function licenses(): Plugin {
  return {
    name: "epoch-site-licenses",
    generateBundle() {
      for (const file of readdirSync(data).filter((f) =>
        f.endsWith(".LICENSE.txt"),
      ))
        this.emitFile({
          type: "asset",
          fileName: `data/${file}`,
          source: readFileSync(join(data, file)),
        });
    },
  };
}

export default defineConfig({
  base: "/Epoch/",
  plugins: [react(), tailwindcss(), licenses()],
  worker: { format: "es" },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1024,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        demo: fileURLToPath(new URL("./demo.html", import.meta.url)),
      },
    },
  },
});
