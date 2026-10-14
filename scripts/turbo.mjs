// Runs the workspace's pinned turbo with telemetry turned off.
//
// Turborepo collects anonymous telemetry by default and honors
// TURBO_TELEMETRY_DISABLED and DO_NOT_TRACK. Routing the root scripts through
// this wrapper keeps `pnpm build | typecheck | test | lint` from sending any,
// on every OS, without a per-machine opt-out (CLAUDE.md: no telemetry).
//
// turbo is started as `node <turbo's JS launcher>` instead of through the
// node_modules/.bin shim: on Windows that shim is a .cmd file, which
// child_process refuses to spawn without a shell, and passing arguments
// together with `shell: true` is deprecated in Node 24 (DEP0190).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const launcher = createRequire(import.meta.url).resolve("turbo/bin/turbo");
const result = spawnSync(
  process.execPath,
  [launcher, ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
