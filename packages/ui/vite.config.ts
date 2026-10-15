import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { devCsp } from "./dev-csp";

// Standalone build of the renderer (the static demo site reuses it in M8).
// The desktop app builds the same sources through electron-vite, which imports
// this config.
export default defineConfig({
  plugins: [react(), tailwindcss(), devCsp()],
  base: "./",
  // The layout worker is created with { type: "module" }.
  worker: { format: "es" },
  // Cytoscape alone is about 430 kB minified (see electron.vite.config.ts).
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1024 },
});
