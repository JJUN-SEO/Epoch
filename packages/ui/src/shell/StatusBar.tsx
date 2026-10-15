import { LANGUAGE_TIERS, type Graph } from "@epoch-dev/core";
import { languageName } from "../languages";

/**
 * Counts, and each analyzed language with its support tier (CLAUDE.md
 * principle 9: show what is resolved precisely and what is best-effort).
 */
export function StatusBar(props: { readonly graph: Graph }) {
  const { graph } = props;
  const byLanguage = new Map<string, number>();
  let other = 0;
  for (const n of graph.nodes) {
    if (LANGUAGE_TIERS[n.language] === undefined) other++;
    else byLanguage.set(n.language, (byLanguage.get(n.language) ?? 0) + 1);
  }
  return (
    <footer className="bg-chrome border-line text-muted flex h-6 shrink-0 items-center gap-4 border-t px-3 text-[11px]">
      <span data-testid="graph-stats">
        {graph.nodes.length} files · {graph.edges.length} edges
        {graph.unresolved.length > 0
          ? ` · ${String(graph.unresolved.length)} unresolved imports`
          : ""}
      </span>
      <span className="ml-auto flex items-center gap-3" aria-label="Languages">
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
