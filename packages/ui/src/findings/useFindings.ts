import { useCallback, useEffect, useState } from "react";
import type { EpochApi, Graph } from "@epoch-dev/core";

export interface FindingsState {
  /** Ids of findings not dismissed; empty until the first answer. */
  readonly open: ReadonlySet<string>;
  readonly ready: boolean;
  /** Dismissing needs the desktop app (the demo cannot store anything). */
  readonly canDismiss: boolean;
  readonly dismiss: (id: string, note?: string) => Promise<void>;
  readonly undismiss: (id: string) => Promise<void>;
}

/**
 * Which of the graph's findings are open: EpochApi.getFindings leaves out
 * dismissed ones, so the rest of graph.findings is what the user dismissed.
 * Refreshed whenever the findings change (the watcher) and after a dismissal.
 */
export function useFindings(
  api: EpochApi,
  graph: Graph,
  canDismiss: boolean,
): FindingsState {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [ready, setReady] = useState(false);
  const ids = graph.findings.map((f) => f.id).join("\u0000");
  const refresh = useCallback(() => {
    api.getFindings().then(
      (list) => {
        setOpen(new Set(list.map((f) => f.id)));
        setReady(true);
      },
      () => {
        // Without an answer, treat every finding as open rather than hide any.
        setOpen(new Set(ids === "" ? [] : ids.split("\u0000")));
        setReady(true);
      },
    );
  }, [api, ids]);
  useEffect(refresh, [refresh]);
  const dismiss = useCallback(
    async (id: string, note?: string) => {
      await api.dismissFinding(id, note);
      refresh();
    },
    [api, refresh],
  );
  const undismiss = useCallback(
    async (id: string) => {
      await api.undismissFinding(id);
      refresh();
    },
    [api, refresh],
  );
  return { open, ready, canDismiss, dismiss, undismiss };
}
