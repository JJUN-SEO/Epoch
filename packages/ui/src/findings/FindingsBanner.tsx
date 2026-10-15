import { Lightbulb } from "lucide-react";
import { FINDING_KIND_LABELS, type FindingKind } from "@epoch-dev/core";
import { Button } from "../components/ui";
import type { FindingsSummary } from "./model";
import { kindCount } from "./text";

const KINDS = Object.keys(FINDING_KIND_LABELS) as FindingKind[];

/**
 * A non-modal strip over the canvas when open findings reach the banner's
 * level (CLAUDE.md "Alerts and review"): counts by kind and a Review button.
 * It never blocks, and closing it only hides it until the counts change.
 */
export function FindingsBanner(props: {
  readonly summary: FindingsSummary;
  readonly onReview: () => void;
  readonly onClose: () => void;
}) {
  const parts = KINDS.filter((k) => props.summary.byKind[k] > 0).map((k) =>
    kindCount(k, props.summary.byKind[k]),
  );
  return (
    <div
      role="status"
      data-testid="findings-banner"
      className="bg-raised/95 border-line shadow-pop absolute top-3 left-1/2 z-10 flex max-w-[min(640px,calc(100%-24px))] -translate-x-1/2 items-center gap-2.5 rounded-lg border py-1.5 pr-1.5 pl-3 text-[12px] backdrop-blur"
    >
      <Lightbulb
        size={15}
        strokeWidth={1.75}
        aria-hidden="true"
        className="text-muted shrink-0"
      />
      <p className="min-w-0 flex-1">
        <span className="font-medium">
          {props.summary.total}{" "}
          {props.summary.total === 1 ? "candidate" : "candidates"} to review
        </span>
        <span className="text-muted">: {parts.join(", ")}</span>
      </p>
      <Button onClick={props.onReview}>Review</Button>
      <button
        type="button"
        className="text-muted hover:text-fg hover:bg-hover inline-flex size-6 shrink-0 items-center justify-center rounded-md"
        aria-label="Hide for now"
        title="Hide for now"
        onClick={props.onClose}
      >
        ×
      </button>
    </div>
  );
}
