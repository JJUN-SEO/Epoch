import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import ui from "../ui/vite.config";

const uiRoot = resolve(import.meta.dirname, "../ui");

/*
 * Bundling rule: the main process, the analysis host and all workspace code
 * are bundled. A package stays external (a runtime "dependency" in
 * package.json, shipped in the packaged app's node_modules) only when it loads
 * files next to itself at runtime: better-sqlite3 (native addon),
 * web-tree-sitter and @vscode/tree-sitter-wasm (WASM), and typescript (large
 * CommonJS; the TS adapter's resolver). electron-vite externalizes exactly the
 * "dependencies" list.
 */
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/main/index.ts"),
        },
      },
    },
  },
  renderer: {
    ...ui,
    root: uiRoot,
    build: {
      outDir: resolve(import.meta.dirname, "out/renderer"),
      emptyOutDir: true,
      // electron-vite turns minification off by default; the UI loads faster
      // with it (641 kB unminified vs 223 kB for an empty React page).
      minify: true,
      rollupOptions: { input: resolve(uiRoot, "index.html") },
    },
  },
});
