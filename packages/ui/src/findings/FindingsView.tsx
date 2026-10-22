import { useMemo, useState } from "react";
import {
  CONFIDENCE_LABELS,
  FINDING_KIND_LABELS,
  atLeast,
  type AnalysisInfo,
  type Confidence,
  type Finding,
  type FindingKind,
  type Graph,
} from "@epoch-dev/core";
import { cx, PathLabel, Segmented, Toggle } from "../components/ui";
import { sortFindings } from "./model";
import { ConfidencePill, InlineText } from "./text";
import type { FindingsState } from "./useFindings";

const KINDS = Object.keys(FINDING_KIND_LABELS) as FindingKind[];

const HISTORY_NOTE: Readonly<
  Record<AnalysisInfo["findings"]["history"], string | undefined>
> = {
  usable: undefined,
  off: "Git history was off: possibly stale flags were not checked and recent changes could not be seen.",
  "not-a-repo":
    "This folder is not a git repository, so possibly stale flags were not checked and recent changes could not be seen.",
  shallow:
    "This is a shallow clone: possibly stale flags were not checked and recent changes could not be seen. Fetching the full history enables these checks.",
  "too-short":
    "The git history is shorter than flags.staleAfterDays, so possibly stale flags were not checked.",
};

function Notices({ analysis }: { readonly analysis: AnalysisInfo | null }) {
  if (!analysis) return null;
  const notes: { key: string; body: React.ReactNode }[] = [];
  const history = HISTORY_NOTE[analysis.findings.history];
  if (history !== undefined) notes.push({ key: "history", body: history });
  for (const fw of analysis.findings.frameworks) {
    notes.push({
      key: `fw:${fw.dir}:${fw.id}`,
      body: (
        <>
          {fw.name} detected{fw.dir === "" ? "" : ` in ${fw.dir}`} (
          {fw.evidence}). It loads some files by convention, so they may look
          unused here. List them in{" "}
          <code className="bg-sunken rounded px-1 font-mono">
            epoch.config.json
          </code>
          , for example:
          <pre className="bg-sunken selectable mt-1 overflow-x-auto rounded-md p-2 font-mono text-[11px]">
            {`{ "entryPoints": ["${fw.dir === "" ? "" : `${fw.dir}/`}path/to/loaded/files/**"] }`}
          </pre>
        </>
      ),
    });
  }
  const n = analysis.findings.unassessableFlags;
  if (n > 0) {
    notes.push({
      key: "unassessable",
      body: `${String(n)} flag ${n === 1 ? "usage has" : "usages have"} a key that is not a string literal and could not be assessed.`,
    });
  }
  for (const w of analysis.config.warnings)
    notes.push({ key: `w:${w}`, body: w });
  if (notes.length === 0) return null;
  return (
    <ul className="space-y-1.5 px-4 pt-3" aria-label="Notes">
      {notes.map((n) => (
        <li
          key={n.key}
          className="border-line bg-raised selectable rounded-md border px-3 py-2 text-[12px]"
        >
          {n.body}
        </li>
      ))}
    </ul>
  );
}

/**
 * Findings for review (CLAUDE.md "Alerts and review"): filter by kind and
 * confidence, sorted by confidence then size, dismissed ones on request.
 */
export function FindingsView(props: {
  readonly graph: Graph;
  readonly analysis: AnalysisInfo | null;
  readonly state: FindingsState;
  readonly selected: string | undefined;
  readonly onSelect: (id: string) => void;
}) {
  const defaultLevel = props.analysis?.findings.minConfidence ?? "medium";
  const [min, setMin] = useState<Confidence>(defaultLevel);
  const [kinds, setKinds] = useState<ReadonlySet<FindingKind>>(new Set(KINDS));
  const [showDismissed, setShowDismissed] = useState(false);
  const sorted = useMemo(
    () => sortFindings(props.graph, props.graph.findings),
    [props.graph],
  );
  const shown = sorted.filter(
    (f) =>
      kinds.has(f.kind) &&
      atLeast(f.confidence, min) &&
      (showDismissed || props.state.open.has(f.id)),
  );
  const hiddenBelow = sorted.filter(
    (f) =>
      kinds.has(f.kind) &&
      !atLeast(f.confidence, min) &&
      props.state.open.has(f.id),
  ).length;
  const dismissedCount = sorted.filter(
    (f) => !props.state.open.has(f.id),
  ).length;

  return (
    <div className="flex h-full flex-col" data-testid="findings-view">
      <header className="border-line border-b px-4 pt-3 pb-2.5">
        <h2 className="text-[15px] font-semibold">Findings</h2>
        <p className="text-muted mt-0.5 text-[12px]">
          Candidates for review, not verdicts: static analysis cannot see
          reflection, tooling or runtime configuration.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Kinds" className="flex flex-wrap gap-1">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kinds.has(k)}
                className={cx(
                  "h-6 rounded-full border px-2 text-[12px]",
                  kinds.has(k)
                    ? "bg-active border-strong-line text-fg"
                    : "border-line text-muted hover:text-fg",
                )}
                onClick={() => {
                  setKinds((s) => {
                    const next = new Set(s);
                    if (next.has(k)) next.delete(k);
                    else next.add(k);
                    return next;
                  });
                }}
              >
                {FINDING_KIND_LABELS[k]}
              </button>
            ))}
          </div>
          <Segmented
            label="Lowest confidence shown"
            value={min}
            onChange={setMin}
            options={(["high", "medium", "low"] as const).map((c) => ({
              value: c,
              label: CONFIDENCE_LABELS[c],
            }))}
          />
          {dismissedCount > 0 && (
            <Toggle
              label={`Show dismissed (${String(dismissedCount)})`}
              checked={showDismissed}
              onChange={setShowDismissed}
            />
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto pb-4">
        <Notices analysis={props.analysis} />
        {shown.length === 0 ? (
          <p className="text-muted px-4 pt-6 text-[13px]">
            {props.graph.findings.length === 0
              ? "Nothing to review: no candidates were found."
              : "Nothing to review with these filters."}
            {hiddenBelow > 0 &&
              ` ${String(hiddenBelow)} more ${hiddenBelow === 1 ? "is" : "are"} rated below ${CONFIDENCE_LABELS[min]}.`}
          </p>
        ) : (
          <ul className="px-2 pt-2" aria-label="Findings">
            {shown.map((f) => (
              <FindingRow
                key={f.id}
                finding={f}
                dismissed={!props.state.open.has(f.id)}
                selected={props.selected === f.id}
                onSelect={() => {
                  props.onSelect(f.id);
                }}
              />
            ))}
          </ul>
        )}
        {shown.length > 0 && hiddenBelow > 0 && (
          <p className="text-muted px-4 pt-2 text-[12px]">
            {hiddenBelow} more {hiddenBelow === 1 ? "is" : "are"} rated below{" "}
            {CONFIDENCE_LABELS[min]}.
          </p>
        )}
      </div>
    </div>
  );
}

function FindingRow(props: {
  readonly finding: Finding;
  readonly dismissed: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const f = props.finding;
  return (
    <li>
      <button
        type="button"
        aria-pressed={props.selected}
        data-finding-id={f.id}
        className={cx(
          "hover:bg-hover w-full rounded-md px-2.5 py-2 text-left",
          props.selected && "bg-active",
          props.dismissed && "opacity-60",
        )}
        onClick={props.onSelect}
      >
        <span className="flex items-center gap-2">
          <ConfidencePill confidence={f.confidence} />
          <span className="text-muted text-[12px]">
            {FINDING_KIND_LABELS[f.kind]}
          </span>
          {props.dismissed && (
            <span className="text-muted text-[11px]">· dismissed</span>
          )}
        </span>
        <span className="mt-1 block text-[13px]">
          {f.subject.type === "flag" ? (
            <code className="font-mono">{f.subject.name}</code>
          ) : (
            <PathLabel id={f.subject.name} />
          )}
          {f.locations.length > 1 && (
            <span className="text-muted"> +{f.locations.length - 1}</span>
          )}
        </span>
        {f.evidence[0] !== undefined && (
          <span className="text-muted mt-0.5 line-clamp-2 block text-[12px]">
            <InlineText text={f.evidence[0]} />
          </span>
        )}
      </button>
    </li>
  );
}
