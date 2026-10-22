import { Fragment } from "react";
import {
  CONFIDENCE_LABELS,
  type Confidence,
  type FindingKind,
} from "@epoch-dev/core";
import { cx } from "../components/ui";

/*
 * How findings read (ADR-007, "soft alerts, never verdicts"). Repository
 * strings are always rendered as text; `backticks` become code spans built
 * as React elements, never HTML.
 */

/** Text with `inline code` spans. */
export function InlineText({ text }: { readonly text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 && i < parts.length - 1 ? (
          <code
            key={i}
            className="bg-sunken rounded px-1 font-mono text-[12px]"
          >
            {part}
          </code>
        ) : (
          <Fragment key={i}>{i % 2 === 1 ? `\`${part}` : part}</Fragment>
        ),
      )}
    </>
  );
}

const KIND_COUNT: Readonly<Record<FindingKind, readonly [string, string]>> = {
  "dead-branch": [
    "branch that likely never runs",
    "branches that likely never run",
  ],
  "stale-flag": ["possibly stale flag", "possibly stale flags"],
  "unreachable-file": ["possibly unused file", "possibly unused files"],
};

/** "3 possibly unused files". */
export function kindCount(kind: FindingKind, n: number): string {
  const [one, many] = KIND_COUNT[kind];
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** Calm tones only: confidence is shown by weight, never by a danger color. */
const TONE: Readonly<Record<Confidence, string>> = {
  high: "bg-active text-fg border-strong-line",
  medium: "bg-sunken text-fg border-line",
  low: "text-muted border-line border-dashed",
};

export function ConfidencePill({
  confidence,
}: {
  readonly confidence: Confidence;
}) {
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center rounded-full border px-1.5 text-[11px] leading-4 font-medium",
        TONE[confidence],
      )}
    >
      {CONFIDENCE_LABELS[confidence]}
    </span>
  );
}
