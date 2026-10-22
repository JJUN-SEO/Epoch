import { useEffect, useState } from "react";
import type { CodePreview as Preview, EpochApi } from "@epoch-dev/core";
import { errorMessage } from "../errors";

/** Context lines shown around a flagged range. */
const CONTEXT = 2;
/** Lines asked for at most (the host caps previews at 200). */
const MAX_LINES = 60;

/**
 * A read-only view of a few lines of a project file, read by the analysis
 * host inside the project root (CLAUDE.md "Alerts and review"). Rendered as
 * text, never as HTML; nothing is cached.
 */
export function CodePreview(props: {
  readonly api: EpochApi;
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
}) {
  const start = Math.max(1, props.line - CONTEXT);
  const end = Math.min(props.endLine + CONTEXT, start + MAX_LINES - 1);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ok"; preview: Preview }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    props.api.getCodePreview(props.file, start, end).then(
      (preview) => {
        if (live) setState({ kind: "ok", preview });
      },
      (error: unknown) => {
        if (live) setState({ kind: "error", message: errorMessage(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [props.api, props.file, start, end]);

  if (state.kind === "loading") {
    return <p className="text-muted px-1 py-1 text-[11px]">Loading preview…</p>;
  }
  if (state.kind === "error") {
    return (
      <p className="text-muted px-1 py-1 text-[11px]">
        Preview unavailable: {state.message}
      </p>
    );
  }
  const { preview } = state;
  const width = String(preview.startLine + preview.lines.length).length;
  return (
    <pre
      className="bg-sunken border-line selectable mt-1 max-h-72 overflow-auto rounded-md border py-1.5 font-mono text-[11px] leading-[1.45]"
      data-testid="code-preview"
    >
      {preview.lines.map((text, i) => {
        const n = preview.startLine + i;
        const flagged = n >= props.line && n <= props.endLine;
        return (
          <div
            key={n}
            className={flagged ? "bg-active" : undefined}
            aria-current={flagged ? "true" : undefined}
          >
            <span className="text-faint inline-block pr-3 pl-2 text-right select-none">
              {String(n).padStart(width, " ")}
            </span>
            <span className="pr-3">{text === "" ? " " : text}</span>
          </div>
        );
      })}
    </pre>
  );
}
