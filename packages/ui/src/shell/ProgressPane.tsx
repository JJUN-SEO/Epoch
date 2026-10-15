import type { Progress, ProjectInfo } from "@epoch-dev/core";

const STAGES: Readonly<Record<Progress["stage"], string>> = {
  discover: "Finding files",
  parse: "Parsing",
  resolve: "Resolving imports",
  graph: "Building the graph",
  done: "Done",
};

/** Analysis progress, inside the window where the graph will appear. */
export function ProgressPane(props: {
  readonly project: ProjectInfo;
  readonly progress: Progress | undefined;
}) {
  const p = props.progress;
  const fraction = p && p.total > 0 ? Math.min(1, p.done / p.total) : 0;
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center">
      <div className="border-line bg-raised shadow-pop flex w-[min(440px,90vw)] flex-col gap-3 rounded-xl border p-5">
        <div>
          <h1 className="truncate text-[15px] font-semibold">
            {props.project.name}
          </h1>
          <p className="text-muted truncate text-xs" title={props.project.root}>
            {props.project.root}
          </p>
        </div>
        <div
          role="progressbar"
          aria-label="Analysis progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fraction * 100)}
          className="bg-sunken h-1.5 overflow-hidden rounded-full"
        >
          <div
            className="bg-accent h-full rounded-full transition-[width]"
            style={{ width: `${String(fraction * 100)}%` }}
          />
        </div>
        <p className="text-muted text-xs" data-testid="progress-stage">
          {p ? STAGES[p.stage] : "Starting"}
          {p && p.stage !== "done" && p.total > 1
            ? ` ${String(p.done)} / ${String(p.total)}`
            : ""}
        </p>
      </div>
    </main>
  );
}
