import type { RenderProcessGoneDetails } from "electron";

/** What recovery needs from a project window (index.ts wires the real one). */
export interface RecoveryTarget {
  onGone(listener: (details: RenderProcessGoneDetails) => void): void;
  onUnresponsive(listener: () => void): void;
  onResponsive(listener: () => void): void;
  /** Loads the UI again. */
  reload(): void;
  /** Asks whether to reload; the signal closes the question. */
  askReload(signal: AbortSignal): Promise<boolean>;
}

/**
 * Keeps a project window usable when its renderer fails. A renderer that
 * crashes (a GPU driver fault, out of memory) would leave a blank window:
 * the UI loads again, at most `limit` times per `windowMs` so a renderer
 * that crashes on start does not loop. A renderer that stops responding
 * gets a question (wait, or reload), closed again if it recovers.
 */
export function recoverWindow(
  target: RecoveryTarget,
  opts: {
    readonly now?: () => number;
    readonly limit?: number;
    readonly windowMs?: number;
  } = {},
): void {
  const now = opts.now ?? Date.now;
  const limit = opts.limit ?? 3;
  const windowMs = opts.windowMs ?? 60_000;
  let crashes: number[] = [];
  target.onGone((details) => {
    if (details.reason === "clean-exit") return;
    const t = now();
    crashes = crashes.filter((at) => t - at < windowMs);
    if (crashes.length >= limit) return;
    crashes.push(t);
    target.reload();
  });

  let asking: AbortController | undefined;
  target.onUnresponsive(() => {
    if (asking) return;
    const controller = new AbortController();
    asking = controller;
    void target.askReload(controller.signal).then(
      (reload) => {
        if (asking === controller) asking = undefined;
        if (reload && !controller.signal.aborted) target.reload();
      },
      () => {
        if (asking === controller) asking = undefined;
      },
    );
  });
  target.onResponsive(() => {
    asking?.abort();
    asking = undefined;
  });
}
