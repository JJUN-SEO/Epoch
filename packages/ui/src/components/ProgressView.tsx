import type { Progress, ProjectInfo } from "@epoch-dev/core";

const STAGES: Readonly<Record<Progress["stage"], string>> = {
  discover: "Finding files",
  parse: "Parsing",
  resolve: "Resolving imports",
  graph: "Building the graph",
  done: "Done",
};

export function ProgressView(props: {
  readonly project: ProjectInfo;
  readonly progress: Progress | undefined;
}) {
  const p = props.progress;
  const fraction = p && p.total > 0 ? Math.min(1, p.done / p.total) : 0;
  return (
    <main className="mx-auto flex h-full max-w-xl flex-col justify-center gap-4 p-8">
      <h1 className="text-xl font-semibold break-all">{props.project.name}</h1>
      <p className="text-sm text-neutral-500 break-all">{props.project.root}</p>
      <div
        role="progressbar"
        aria-label="Analysis progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        className="h-2 overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800"
      >
        <div
          className="h-full bg-blue-600 transition-[width]"
          style={{ width: `${String(fraction * 100)}%` }}
        />
      </div>
      <p className="text-sm" data-testid="progress-stage">
        {p ? STAGES[p.stage] : "Starting"}
        {p && p.stage !== "done" && p.total > 1
          ? ` ${String(p.done)} / ${String(p.total)}`
          : ""}
      </p>
    </main>
  );
}
