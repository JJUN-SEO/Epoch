import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import ui from "../ui/vite.config";

const uiRoot = resolve(import.meta.dirname, "../ui");

/*
 * Bundling rule: the main process, the analysis host and all workspace code
 * are bundled. A package stays external (a runtime "dependency" in
 * package.json, shipped in the packaged app's node_modules) only when it loads
 * files next to itself at runtime: better-sqlite3 and onnxruntime-node
 * (native addons; the latter loaded only when the local model runs),
 * web-tree-sitter and @vscode/tree-sitter-wasm (WASM), piscina (its worker
 * runtime), and typescript (large CommonJS; the TS adapter's resolver). electron-vite externalizes exactly the
 * "dependencies" list.
 */
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/main/index.ts"),
          // The analysis host, forked by main as a utilityProcess, and its
          // parse workers (worker threads).
          host: resolve(import.meta.dirname, "src/host/index.ts"),
          "parse-worker": resolve(
            import.meta.dirname,
            "src/host/parse-worker.ts",
          ),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/preload/index.ts"),
        },
        // Sandboxed preloads must be CommonJS (Electron "Process Sandboxing").
        output: { format: "cjs", entryFileNames: "[name].cjs" },
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
      // Loaded from disk, never downloaded: Cytoscape alone is about 430 kB
      // minified, in the page and again in the layout worker.
      chunkSizeWarningLimit: 1024,
      rollupOptions: { input: resolve(uiRoot, "index.html") },
    },
  },
});
