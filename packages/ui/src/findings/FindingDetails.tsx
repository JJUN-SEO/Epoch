import { useState } from "react";
import {
  CONFIDENCE_LABELS,
  FINDING_KIND_LABELS,
  RUBRIC_CAPS,
  type EpochApi,
  type Finding,
  type Graph,
  type RubricCap,
} from "@epoch-dev/core";
import { Button, PathLabel, SectionTitle } from "../components/ui";
import { errorMessage } from "../errors";
import { CodePreview } from "./CodePreview";
import { findingNodes } from "./model";
import { ConfidencePill, InlineText } from "./text";
import type { FindingsState } from "./useFindings";

const isCap = (c: string): c is RubricCap => c in RUBRIC_CAPS;
/** Previews shown at most per finding (each is a request to the host). */
const MAX_PREVIEWS = 3;
const MAX_NOTE = 1000;

/**
 * One finding in the inspector: caveats first (what static analysis cannot
 * see), then the evidence, why it got its rating, a suggested next step,
 * where it is (with a read-only preview), and dismiss or restore.
 */
export function FindingDetails(props: {
  readonly api: EpochApi;
  readonly graph: Graph;
  readonly finding: Finding;
  readonly state: FindingsState;
  /** Select and show a graph node. */
  readonly onShow: (id: string) => void;
  /** Whether code previews are available (not in the static demo). */
  readonly previews: boolean;
}) {
  const f = props.finding;
  const dismissed = props.state.ready && !props.state.open.has(f.id);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const caps = f.caps.filter(isCap);
  const nodes = new Set(props.graph.nodes.map((n) => n.id));
  const nodeOfFile = (file: string) =>
    nodes.has(file)
      ? file
      : findingNodes(props.graph, { ...f, locations: [{ file }] })[0];

  const act = (run: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    run().then(
      () => {
        setBusy(false);
        setNote("");
      },
      (e: unknown) => {
        setBusy(false);
        setError(errorMessage(e));
      },
    );
  };

  return (
    <div className="pb-4" data-testid="finding-details">
      <div className="px-3 pt-3">
        <div className="flex items-center gap-2">
          <ConfidencePill confidence={f.confidence} />
          <span className="text-muted text-[12px]">
            {FINDING_KIND_LABELS[f.kind]}
          </span>
        </div>
        <h2 className="mt-1.5 text-[14px] font-semibold">
          {f.subject.type === "flag" ? (
            <code className="font-mono">{f.subject.name}</code>
          ) : (
            <PathLabel id={f.subject.name} />
          )}
        </h2>
        {caps.length > 0 && (
          <p className="text-muted mt-1 text-[12px]">
            Rated {CONFIDENCE_LABELS[f.confidence]} because{" "}
            {caps.map((c) => RUBRIC_CAPS[c].reason).join("; ")}.
          </p>
        )}
      </div>

      <SectionTitle>Keep in mind</SectionTitle>
      <ul className="selectable list-disc space-y-1 pr-3 pl-7 text-[12px]">
        {f.caveats.map((c) => (
          <li key={c}>
            <InlineText text={c} />
          </li>
        ))}
      </ul>

      <SectionTitle>Why it was flagged</SectionTitle>
      <ul className="selectable list-disc space-y-1 pr-3 pl-7 text-[12px]">
        {f.evidence.map((e) => (
          <li key={e}>
            <InlineText text={e} />
          </li>
        ))}
      </ul>

      <SectionTitle>Next step</SectionTitle>
      <p className="selectable px-3 text-[12px]">
        <InlineText text={f.suggestedAction} />
      </p>

      <SectionTitle>Where</SectionTitle>
      <ul className="space-y-2 px-3">
        {f.locations.map((l, i) => {
          const node = nodeOfFile(l.file);
          return (
            <li key={`${l.file}:${String(l.line ?? 0)}`}>
              <button
                type="button"
                className="hover:bg-hover -mx-1 rounded-md px-1 text-left text-[12px] disabled:hover:bg-transparent"
                disabled={node === undefined}
                title={node === undefined ? undefined : "Show in graph"}
                onClick={() => {
                  if (node !== undefined) props.onShow(node);
                }}
              >
                <PathLabel id={l.file} />
                {l.line !== undefined && (
                  <span className="text-muted">
                    :{l.line}
                    {l.endLine !== undefined && l.endLine !== l.line
                      ? `–${String(l.endLine)}`
                      : ""}
                  </span>
                )}
              </button>
              {props.previews && l.line !== undefined && i < MAX_PREVIEWS && (
                <CodePreview
                  api={props.api}
                  file={l.file}
                  line={l.line}
                  endLine={l.endLine ?? l.line}
                />
              )}
            </li>
          );
        })}
      </ul>

      {props.state.canDismiss && (
        <>
          <SectionTitle>{dismissed ? "Dismissed" : "Review"}</SectionTitle>
          <div className="space-y-2 px-3">
            {dismissed ? (
              <Button
                disabled={busy}
                onClick={() => {
                  act(() => props.state.undismiss(f.id));
                }}
              >
                Restore
              </Button>
            ) : (
              <>
                <label className="block text-[12px]">
                  <span className="text-muted">Note (optional)</span>
                  <textarea
                    className="border-line bg-canvas mt-1 block w-full rounded-md border px-2 py-1 text-[12px]"
                    rows={2}
                    maxLength={MAX_NOTE}
                    value={note}
                    onChange={(e) => {
                      setNote(e.target.value);
                    }}
                    placeholder="e.g. loaded by our plugin system"
                  />
                </label>
                <Button
                  disabled={busy}
                  onClick={() => {
                    act(() =>
                      props.state.dismiss(
                        f.id,
                        note.trim() === "" ? undefined : note,
                      ),
                    );
                  }}
                >
                  Dismiss
                </Button>
                <p className="text-muted text-[11px]">
                  Dismissals are kept in Epoch&apos;s own data folder, never in
                  the project.
                </p>
              </>
            )}
            {error !== undefined && (
              <p className="text-[12px]">Could not save: {error}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
