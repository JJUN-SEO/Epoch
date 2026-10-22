import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CachedSummary,
  EpochApi,
  SummaryMeta,
  SummaryProgress,
  SummaryState,
} from "@epoch-dev/core";
import { Button, SectionTitle } from "../components/ui";
import { errorMessage } from "../errors";
import {
  APPROVAL_TEXT,
  FAILED_TEXT,
  UNAVAILABLE_TEXT,
  needsSettings,
  planText,
  staleText,
} from "./text";

/*
 * The model-written summary of the selected file, package or folder (M7,
 * ADR-016). After the selection has held for a moment, it asks main, which
 * spends only under the auto rules; anything else comes back as a plan to
 * approve. Text is shown as plain text and labeled model-generated.
 */

/** How long a selection holds before a summary is asked for. */
export const SUMMARY_HOLD_MS = 750;

export interface SummarySectionProps {
  readonly api: EpochApi;
  /** A node id, or "dir:<path>" for a folder. */
  readonly subject: string;
  readonly onOpenSettings?: (() => void) | undefined;
  /** Something may have been spent (to refresh the status bar). */
  readonly onSpent?: (() => void) | undefined;
}

function Meta({ meta }: { readonly meta: SummaryMeta }) {
  const cost =
    meta.costUsd > 0
      ? ` · $${meta.costUsd < 0.01 ? meta.costUsd.toFixed(4) : meta.costUsd.toFixed(2)}`
      : "";
  return (
    <p className="text-muted mt-1 text-[11px]">
      Model-generated · {meta.model} · {meta.createdAt.slice(0, 10)}
      {cost}
    </p>
  );
}

function Text({
  text,
  meta,
  stale,
}: {
  readonly text: string;
  readonly meta: SummaryMeta;
  readonly stale?: string | undefined;
}) {
  return (
    <div className="px-3">
      {stale !== undefined && (
        <p className="text-muted mb-1 text-[11px] italic">{stale}</p>
      )}
      <p
        data-testid="summary-text"
        className={`selectable text-[13px] leading-relaxed ${stale === undefined ? "" : "text-muted"}`}
      >
        {text}
      </p>
      <Meta meta={meta} />
    </div>
  );
}

const cachedView = (cached: CachedSummary | undefined) =>
  cached && (
    <Text
      text={cached.text}
      meta={cached.meta}
      stale={staleText(cached.stale)}
    />
  );

export function SummarySection({
  api,
  subject,
  onOpenSettings,
  onSpent,
}: SummarySectionProps) {
  const [state, setState] = useState<SummaryState | "waiting" | "working">(
    "waiting",
  );
  const [progress, setProgress] = useState<SummaryProgress>();
  /** The plan being run, whose progress this shows. */
  const [running, setRunning] = useState<string>();
  const [error, setError] = useState<string>();
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const settle = useCallback(
    (p: Promise<SummaryState>) => {
      p.then(
        (s) => {
          if (live.current) setState(s);
          onSpent?.();
        },
        (e: unknown) => {
          if (live.current) setError(errorMessage(e));
        },
      );
    },
    [onSpent],
  );

  // Ask once the selection has held: main spends only under the auto rules.
  useEffect(() => {
    setState("waiting");
    setError(undefined);
    setProgress(undefined);
    setRunning(undefined);
    const timer = setTimeout(() => {
      settle(api.getSummary(subject, { auto: true }));
    }, SUMMARY_HOLD_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [api, subject, settle]);

  useEffect(
    () =>
      api.onSummaryProgress((p) => {
        if (p.planId === running) setProgress(p);
      }),
    [api, running],
  );

  const approve = (id: string) => {
    setRunning(id);
    setState("working");
    settle(api.generateSummary(id));
  };
  const retry = () => {
    setState("working");
    settle(api.getSummary(subject));
  };

  let body;
  if (state === "waiting" || state === "working") {
    body = (
      <div className="px-3">
        <p className="text-muted text-[13px]">
          {state === "working"
            ? progress && progress.total > 1
              ? `Summarizing ${String(progress.done + 1)} of ${String(progress.total)}…`
              : "Summarizing…"
            : "…"}
        </p>
        {state === "working" && (
          <Button
            variant="ghost"
            className="mt-1 -ml-2"
            onClick={() => {
              void api.cancelSummaries();
            }}
          >
            Cancel
          </Button>
        )}
      </div>
    );
  } else if (state.state === "ready") {
    body = <Text text={state.text} meta={state.meta} />;
  } else if (state.state === "needs-approval") {
    const { what, cost } = planText(state.plan);
    const note = APPROVAL_TEXT[state.reason];
    body = (
      <>
        {cachedView(state.cached)}
        <div
          data-testid="summary-approval"
          className="border-line bg-raised mx-3 mt-2 rounded-lg border px-3 py-2 text-[12px]"
        >
          {note !== "" && <p className="mb-1 font-medium">{note}</p>}
          <p className="text-muted">{what}</p>
          <p className="text-muted">{cost}</p>
          <Button
            variant="primary"
            className="mt-2"
            onClick={() => {
              approve(state.planId);
            }}
          >
            {state.cached ? "Update summary" : "Summarize"}
          </Button>
        </div>
      </>
    );
  } else {
    const unavailable = state.state === "unavailable";
    body = (
      <>
        {cachedView(state.cached)}
        <div className="flex flex-wrap items-center gap-2 px-3 pt-1">
          <p className="text-muted text-[12px]">
            {unavailable
              ? UNAVAILABLE_TEXT[state.reason]
              : FAILED_TEXT[state.reason]}
          </p>
          {unavailable && needsSettings(state.reason) && onOpenSettings && (
            <Button variant="ghost" onClick={onOpenSettings}>
              Settings…
            </Button>
          )}
          {!unavailable && (
            <Button variant="ghost" onClick={retry}>
              Try again
            </Button>
          )}
        </div>
      </>
    );
  }

  return (
    <section aria-label="Summary" data-testid="summary">
      <SectionTitle>
        <span className="inline-flex items-center gap-1.5">
          <Sparkles size={12} aria-hidden="true" />
          Summary
        </span>
      </SectionTitle>
      {body}
      {error !== undefined && (
        <p role="alert" className="text-danger px-3 pt-1 text-[12px]">
          {error}
        </p>
      )}
    </section>
  );
}
