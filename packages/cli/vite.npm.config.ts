import { isAbsolute, resolve } from "node:path";
import { defineConfig } from "vite";

/** A package npm installs: any bare import that is not workspace code. */
const thirdParty = (id: string): boolean =>
  !id.startsWith(".") &&
  !id.startsWith("\0") &&
  !isAbsolute(id) &&
  !id.startsWith("@epoch-dev/");

/*
 * The npm package's bundle (ADR-018): the CLI and every workspace package in
 * a few files, with third-party packages left as imports for npm to install
 * (scripts/pack-cli.mjs writes them into the published manifest). The parse
 * worker is its own entry, and chunks sit beside the entries, so the pool
 * finds `./parse-worker.js` next to whichever file asks for it.
 */
export default defineConfig({
  build: {
    ssr: true,
    target: "node24",
    outDir: resolve(import.meta.dirname, "npm/dist"),
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      external: thirdParty,
      input: {
        bin: resolve(import.meta.dirname, "src/bin.ts"),
        "parse-worker": resolve(import.meta.dirname, "src/parse-worker.ts"),
      },
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "[name]-[hash].js",
      },
    },
  },
  // Workspace code is bundled; `external` above keeps everything else an import.
  ssr: { noExternal: true },
});
