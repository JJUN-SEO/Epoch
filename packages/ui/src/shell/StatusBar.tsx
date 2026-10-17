import {
  LANGUAGE_TIERS,
  isHintEdge,
  type AnalysisInfo,
  type Graph,
  type WatchStatus,
} from "@epoch-dev/core";
import { languageName } from "../languages";

const plural = (n: number, one: string, many = `${one}s`) =>
  `${String(n)} ${n === 1 ? one : many}`;

/** Packages and files separately: Go mixes both granularities (ADR-013). */
export function nodeCounts(graph: Graph): string {
  let packages = 0;
  for (const n of graph.nodes) if (n.kind === "package") packages++;
  const files = graph.nodes.length - packages;
  return packages > 0
    ? `${plural(packages, "package")} · ${plural(files, "file")}`
    : plural(files, "file");
}

/** One line on the git history the risk tiers used, or why there is none. */
export function gitSummary(info: AnalysisInfo | null): {
  text: string;
  title: string;
} | null {
  const git = info?.git;
  if (!git) return null;
  switch (git.status) {
    case "usable": {
      const until =
        git.churnUntil === undefined
          ? ""
          : ` to ${new Date(git.churnUntil * 1000).toISOString().slice(0, 10)}`;
      return {
        text: `Churn: 90 days${until}${git.shallow === true ? " (shallow clone)" : ""}`,
        title:
          git.shallow === true
            ? "A shallow clone: only the fetched history counts toward churn and risk."
            : "Risk uses commits in the 90 days before the last commit.",
      };
    }
    case "not-a-repo":
      return {
        text: "No git history",
        title:
          "Risk needs git history; this folder isn't a git repository. Fan-in and coverage are still shown.",
      };
    case "no-commits":
      return {
        text: "No commits yet",
        title: "Risk needs git history; this repository has no commits yet.",
      };
    case "git-unavailable":
      return {
        text: "git not found",
        title:
          "Risk needs git history, and git is not installed or not on PATH.",
      };
    case "off":
      return null;
  }
}

/** One line on the hint edges (likely relations), and what they rest on. */
export function hintsSummary(info: AnalysisInfo | null): {
  text: string;
  title: string;
} | null {
  const h = info?.hints;
  if (!h) return null;
  if (h.scorer === "none") {
    return { text: "Hints off", title: "Likely relations were not computed." };
  }
  const c = h.cochange;
  const cochange =
    c.status === "usable" || c.status === "shallow"
      ? `co-change in ${plural(c.commits, "commit")} of the last year${c.status === "shallow" ? " (a shallow clone: only the fetched history)" : ""}`
      : c.status === "not-a-repo"
        ? "no co-change (not a git repository)"
        : c.status === "off"
          ? "no co-change (off)"
          : `no co-change (${c.status})`;
  const e = h.embeddings;
  const model = e.model ?? "the local model";
  const similarity =
    e.status === "ready"
      ? `; similar content (${plural(e.pairs, "pair")}, ${model}, on this machine)`
      : e.status === "pending"
        ? `; similar content: being computed by ${model}, on this machine`
        : e.status === "unavailable"
          ? `; no similar content (${model} could not be loaded)`
          : "";
  return {
    text: `${plural(h.edges, "likely relation")}${e.status === "pending" ? " (adding similarity…)" : ""}`,
    title: `Inferred, not proven: ${cochange}; shared rare strings (${plural(h.strings.pairs, "pair")})${similarity}. Scored by the ${h.scorer} scorer. Drawn dashed when Hints is on; never counted as imports.`,
  };
}

function watchLabel(watch: WatchStatus, updatedAt: Date | undefined) {
  switch (watch.state) {
    case "watching":
      return {
        text:
          updatedAt === undefined
            ? "Watching"
            : `Updated ${updatedAt.toLocaleTimeString()}`,
        title: "Watching the folder: the graph updates as files change.",
        tone: "text-muted",
        live: true,
      };
    case "updating":
      return {
        text: "Updating…",
        title: "Files changed; analyzing again.",
        tone: "text-muted",
        live: true,
      };
    case "error":
      return {
        text: "Update failed",
        title: watch.message,
        tone: "text-danger",
        live: false,
      };
    case "stopped":
      return {
        text: "Not watching",
        title: watch.message,
        tone: "text-danger",
        live: false,
      };
  }
}

/**
 * Counts, the watcher, what the analysis used (git history, coverage), and
 * each analyzed language with its support tier (CLAUDE.md principle 9: show
 * what is resolved precisely and what is best-effort).
 */
export function StatusBar(props: {
  readonly graph: Graph;
  readonly watch?: WatchStatus | undefined;
  readonly analysis?: AnalysisInfo | null;
  readonly updatedAt?: Date | undefined;
  /** Offline mode is on (the desktop app). */
  readonly offline?: boolean | undefined;
  /** What model features spent this month, in dollars. */
  readonly monthUsd?: number | undefined;
}) {
  const { graph } = props;
  const byLanguage = new Map<string, number>();
  let other = 0;
  for (const n of graph.nodes) {
    if (LANGUAGE_TIERS[n.language] === undefined) other++;
    else byLanguage.set(n.language, (byLanguage.get(n.language) ?? 0) + 1);
  }
  const git = gitSummary(props.analysis ?? null);
  const hints = hintsSummary(props.analysis ?? null);
  let hintEdges = 0;
  for (const e of graph.edges) if (isHintEdge(e)) hintEdges++;
  const coverage = props.analysis?.coverage;
  const watch = props.watch && watchLabel(props.watch, props.updatedAt);
  return (
    <footer className="bg-chrome border-line text-muted flex h-6 shrink-0 items-center gap-4 border-t px-3 text-[11px] whitespace-nowrap">
      {props.offline === true && (
        <span
          data-testid="offline-status"
          className="text-fg inline-flex items-center gap-1.5 font-medium"
          title="Offline mode: Epoch makes no network requests. A model on this machine still works if you chose one."
        >
          Offline
        </span>
      )}
      {props.monthUsd !== undefined && props.monthUsd > 0 && (
        <span
          data-testid="spend-status"
          title="What summaries cost this month, at your prices"
        >
          $
          {props.monthUsd < 0.01
            ? props.monthUsd.toFixed(4)
            : props.monthUsd.toFixed(2)}{" "}
          this month
        </span>
      )}
      <span data-testid="graph-stats">
        {nodeCounts(graph)} · {graph.edges.length - hintEdges} edges
        {graph.unresolved.length > 0
          ? ` · ${String(graph.unresolved.length)} unresolved imports`
          : ""}
      </span>
      {watch && (
        <span
          data-testid="watch-status"
          className={`inline-flex items-center gap-1.5 ${watch.tone}`}
          title={watch.title}
        >
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${watch.live ? "bg-imports" : "bg-danger"}`}
          />
          {watch.text}
        </span>
      )}
      {git && (
        <span data-testid="git-status" title={git.title}>
          {git.text}
        </span>
      )}
      {hints && (
        <span data-testid="hints-status" title={hints.title}>
          {hints.text}
        </span>
      )}
      {props.analysis && (
        <span
          data-testid="coverage-status"
          title={
            coverage
              ? `Coverage from ${coverage.source} (${coverage.format}): ${String(coverage.files)} files matched${coverage.unmatched > 0 ? `, ${String(coverage.unmatched)} unmatched` : ""}. The report may be older than the code.`
              : "No coverage report found (coverage/lcov.info, coverage/cobertura-coverage.xml, coverage.xml or lcov.info); risk uses fan-in and churn only."
          }
        >
          {coverage ? `Coverage: ${coverage.source}` : "No coverage report"}
        </span>
      )}
      <span
        className="ml-auto flex min-w-0 items-center gap-3 overflow-hidden"
        aria-label="Languages"
      >
        {[...byLanguage.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([language, count]) => {
            const tier = LANGUAGE_TIERS[language];
            return (
              <span
                key={language}
                title={
                  tier === "A"
                    ? "Tier A: imports resolved the way the language resolves them"
                    : "Tier B: best-effort resolution; accuracy not yet measured"
                }
              >
                {languageName(language)} {count} ·{" "}
                <span className={tier === "A" ? "text-fg" : "text-dependents"}>
                  tier {tier}
                  {tier === "B" ? " (best-effort)" : ""}
                </span>
              </span>
            );
          })}
        {other > 0 && <span>{other} other</span>}
      </span>
    </footer>
  );
}
