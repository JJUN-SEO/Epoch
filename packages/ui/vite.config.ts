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
  build: { outDir: "dist", emptyOutDir: true },
});
