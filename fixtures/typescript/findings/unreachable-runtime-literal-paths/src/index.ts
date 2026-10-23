import { fork } from "node:child_process";
import path from "node:path";

export const layout = new Worker(new URL("./layout.worker.ts", import.meta.url), {
  type: "module",
});
export const run = () => fork(path.join(__dirname, "run-once.js"));
