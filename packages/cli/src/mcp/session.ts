import {
  DismissalStore,
  analyze,
  changedSince,
  openCache,
  watchProject,
  type AnalyzeOptions,
  type AnalyzeResult,
  type ProjectWatcher,
  type SqliteCacheStore,
} from "@epoch-dev/engine";
import { parsePool } from "../pool.js";
import type { ToolContext } from "./tools.js";

/*
 * One project, analyzed once and kept fresh for the agent server (ADR-021).
 * The same watcher as the desktop app re-analyzes after each batch of
 * changes, through the shared cache; a tool call waits for a re-analysis in
 * flight, so it answers from the files as they are, not as they were.
 */

/** The watcher's quiet time here: an agent asks right after it edits. */
const QUIET_MS = 50;
const MAX_MS = 1000;
/** How long a call waits for a save that just happened to reach the watcher. */
const SETTLE_MS = QUIET_MS + 30;
/** Without a watcher (the OS watch limit), how old an analysis may be. */
const STALE_MS = 5000;

export interface AgentSession {
  /** The latest analysis, after any re-analysis in flight. */
  context(): Promise<ToolContext>;
  close(): Promise<void>;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export function openSession(
  target: string,
  log: (line: string) => void,
): AgentSession {
  let cache: SqliteCacheStore | undefined;
  try {
    cache = openCache();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`epoch: cache unavailable (${message}); analyzing without it\n`);
  }
  const pool = parsePool();
  const options: AnalyzeOptions = { pool, ...(cache ? { cache } : {}) };

  let latest: AnalyzeResult | undefined;
  let analyzedAt = 0;
  let watcher: ProjectWatcher | undefined;
  // Fields, not locals: the watcher's callbacks change them between awaits.
  const state: {
    stopped: boolean;
    closed: boolean;
    idle: Promise<void>;
    release: (() => void) | undefined;
  } = {
    stopped: false,
    closed: false,
    idle: Promise.resolve(),
    release: undefined,
  };
  // A call, so the check re-reads the field after each await.
  const isClosed = (): boolean => state.closed;
  const accept = (result: AnalyzeResult) => {
    latest = result;
    analyzedAt = Date.now();
  };

  const started = (async () => {
    const first = await analyze(target, options);
    accept(first);
    if (isClosed()) return;
    watcher = await watchProject(first, {
      analyze: options,
      quietMs: QUIET_MS,
      maxMs: MAX_MS,
      onUpdate: accept,
      onStatus: (s) => {
        if (s.state === "updating") {
          if (!state.release) {
            state.idle = new Promise<void>((resolve) => {
              state.release = resolve;
            });
          }
          return;
        }
        state.release?.();
        state.release = undefined;
        if (s.state === "stopped") {
          state.stopped = true;
          log(`epoch: ${s.message}\n`);
        } else if (s.state === "error") {
          log(`epoch: re-analysis failed: ${s.message}\n`);
        }
      },
    });
    if (isClosed()) await watcher.close();
  })();
  // A failure is reported by the first tool call, not as an unhandled rejection.
  started.catch(() => undefined);

  return {
    async context() {
      await started;
      await delay(SETTLE_MS);
      await state.idle;
      if (state.stopped && Date.now() - analyzedAt > STALE_MS) {
        accept(await analyze(target, options));
      }
      const result = latest;
      if (!result) throw new Error("The project has not been analyzed.");
      return {
        root: result.root,
        snapshot: {
          graph: result.graph,
          meta: result.meta,
          packages: result.packages,
          dismissed: DismissalStore.forProject(result.root).ids(),
        },
        changedSince: (base) => changedSince(result.root, base),
      };
    },
    async close() {
      state.closed = true;
      await started.catch(() => undefined);
      await watcher?.close();
      cache?.close();
      await pool.destroy();
    },
  };
}
