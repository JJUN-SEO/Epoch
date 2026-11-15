import { ParsePool } from "@epoch-dev/engine";

/**
 * The parse pool with the CLI's own worker entry (parse-worker.ts), which
 * sits next to this module in the build tree and in the npm bundle.
 */
export const parsePool = (): ParsePool =>
  new ParsePool({ workerFile: new URL("./parse-worker.js", import.meta.url) });
