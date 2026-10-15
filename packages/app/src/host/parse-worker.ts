// A parse worker for the host's ParsePool, bundled as its own entry so the
// worker loads from a known path inside the app (see electron.vite.config.ts).
export { default } from "@epoch-dev/engine/parse-worker";
