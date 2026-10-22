import {
  CONFIG_ENTRY_SOURCE,
  REACHABILITY_EDGE_KINDS,
  applyCaps,
  hintSourceLabel,
  isHintEdge,
  stronglyConnectedComponents,
  type EntryPoint,
  type Finding,
  type GitHistoryProvider,
  type Graph,
  type GraphEdge,
  type RubricCap,
} from "@epoch-dev/core";
import { frameworkMatcher, type DetectedFramework } from "./frameworks.js";
import {
  daysBetween,
  listSome,
  plural,
  type FindingsFile,
  type HistoryStatus,
} from "./input.js";

/*
 * unreachable-file (CLAUDE.md "Unreachable files"): files no entry point
 * reaches over fact edges (all kinds, via-barrel and type-only included).
 * A cycle no root reaches, and a Go package, are one finding each.
 */

export const UNREACHABLE_CAVEAT =
  "Not referenced by analyzed code; may be loaded by tooling, reflection, or runtime configuration.";

const DECLARATION = /\.d\.[cm]?ts$|\.pyi$/;

/**
 * Roots that declare a package's entry points (CLAUDE.md: "no manifest or
 * config entry point was mapped to source"): manifest fields, and
 * epoch.config.json entryPoints. Scripts, tool configs, conventions and tests
 * are roots too, but they do not say the list is complete.
 */
const declaresEntries = (r: EntryPoint): boolean =>
  r.reason === "manifest" ||
  (r.reason === "config" && r.source === CONFIG_ENTRY_SOURCE);

const HISTORY_CAVEAT: Readonly<Record<HistoryStatus, string>> = {
  usable:
    "Git history was not available, so recent changes could not be checked.",
  off: "Git history was off, so recent changes could not be checked.",
  "not-a-repo":
    "This is not a git repository, so recent changes could not be checked.",
  shallow:
    "Only part of the git history is present (a shallow clone), so recent changes could not be checked.",
  "too-short":
    "The git history is short, so recent changes could not be told apart from old code.",
};

const dirOf = (p: string): string =>
  p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const inside = (path: string, dir: string): boolean =>
  dir === "" || path.startsWith(`${dir}/`);

export interface UnreachableInput {
  readonly graph: Graph;
  readonly files: readonly FindingsFile[];
  readonly packages: ReadonlyMap<string, readonly string[]>;
  readonly roots: readonly EntryPoint[];
  readonly packageDirs: readonly string[];
  readonly frameworks: readonly DetectedFramework[];
  readonly suppressed: (path: string) => boolean;
  readonly history?: GitHistoryProvider;
  readonly historyStatus: HistoryStatus;
  readonly now: Date;
  readonly staleAfterDays: number;
  /** Hint edges at or above this confidence cap a finding (strong-hint). */
  readonly hintThreshold: number;
  readonly hash: (text: string) => string;
}

/**
 * What each node imports, over fact edges. Python adds one rule: importing a
 * module runs the __init__.py of every package above it.
 */
function importsOf(input: UnreachableInput): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    const list = adj.get(from);
    if (list) list.push(to);
    else adj.set(from, [to]);
  };
  for (const e of input.graph.edges) {
    if (REACHABILITY_EDGE_KINDS.has(e.kind)) link(e.source, e.target);
  }
  const paths = new Set(input.files.map((f) => f.path));
  for (const f of input.files) {
    if (f.language !== "python") continue;
    let d = dirOf(f.path);
    if (f.path.endsWith("/__init__.py")) d = dirOf(d);
    for (;;) {
      const init = d === "" ? "__init__.py" : `${d}/__init__.py`;
      if (paths.has(init) && init !== f.path) link(f.path, init);
      if (d === "") break;
      d = dirOf(d);
    }
  }
  return adj;
}

/** Breadth-first from `start` over `adj`, in order; `start` comes first. */
function walk(
  start: readonly string[],
  adj: ReadonlyMap<string, readonly string[]>,
  visit: (node: string, from: string | undefined) => boolean,
): void {
  const queue: [string, string | undefined][] = start.map((s) => [
    s,
    undefined,
  ]);
  // An array iterator also visits what is pushed while it runs.
  for (const [node, from] of queue) {
    if (!visit(node, from)) continue;
    for (const next of adj.get(node) ?? []) queue.push([next, node]);
  }
}

/** How a file may be loaded with no analyzed import reaching it. */
type MaybeLoaded =
  | { readonly by: "prefix"; readonly prefix: string; readonly via?: string }
  | {
      readonly by: "framework";
      readonly framework: DetectedFramework;
      readonly via?: string;
    };

export async function unreachableFindings(
  input: UnreachableInput,
): Promise<Finding[]> {
  const memberOf = new Map<string, string>();
  for (const [pkg, members] of input.packages) {
    for (const m of members) memberOf.set(m, pkg);
  }
  const nodeOf = (file: string) => memberOf.get(file) ?? file;
  const adj = importsOf(input);
  const reached = new Set<string>();
  walk([...new Set(input.roots.map((r) => nodeOf(r.file)))], adj, (node) => {
    if (reached.has(node)) return false;
    reached.add(node);
    return true;
  });
  const byPath = new Map(input.files.map((f) => [f.path, f]));
  const reportable = (path: string): boolean => {
    const f = byPath.get(path);
    return (
      f !== undefined &&
      !f.isTest &&
      !f.facts.isGenerated &&
      !DECLARATION.test(path) &&
      !input.suppressed(path)
    );
  };

  // Unreached nodes and the files each stands for.
  const filesOf = new Map<string, string[]>();
  for (const n of input.graph.nodes) {
    if (reached.has(n.id)) continue;
    const files =
      n.kind === "package"
        ? (input.packages.get(n.id) ?? []).filter(reportable)
        : reportable(n.id)
          ? [n.id]
          : [];
    if (files.length > 0) filesOf.set(n.id, [...files].sort());
  }

  // Group cycles: an unreached strongly connected component is one finding.
  const groupOf = new Map<string, string>();
  for (const component of stronglyConnectedComponents(
    input.graph,
    REACHABILITY_EDGE_KINDS,
  )) {
    const members = component.filter((id) => filesOf.has(id));
    const head = members[0];
    if (head === undefined) continue;
    for (const id of members) groupOf.set(id, head);
  }
  const groups = new Map<string, string[]>();
  for (const id of [...filesOf.keys()].sort()) {
    const head = groupOf.get(id) ?? id;
    groups.set(head, [...(groups.get(head) ?? []), id]);
  }

  const prefixes = [
    ...new Set(input.graph.unresolved.flatMap((u) => u.pathPrefix ?? [])),
  ];
  const framework = frameworkMatcher(input.frameworks);

  // Unreached files a framework may load by convention, or that the prefix
  // of a dynamic import covers, may run; so may everything they import.
  const maybeLoaded = new Map<string, MaybeLoaded>();
  const direct = (id: string): MaybeLoaded | undefined => {
    const files = filesOf.get(id) ?? [id];
    const prefix = prefixes.find((p) => files.some((f) => f.startsWith(p)));
    if (prefix !== undefined) return { by: "prefix", prefix };
    const fw = files.map(framework).find((d) => d !== undefined);
    return fw === undefined ? undefined : { by: "framework", framework: fw };
  };
  const sources = [...filesOf.keys()].sort().filter((id) => direct(id));
  walk(sources, adj, (node, from) => {
    if (reached.has(node) || maybeLoaded.has(node)) return false;
    const own = direct(node);
    const parent = from === undefined ? undefined : maybeLoaded.get(from);
    const how =
      own ??
      (parent && from !== undefined ? { ...parent, via: from } : undefined);
    if (how === undefined) return false;
    maybeLoaded.set(node, how);
    return true;
  });

  // The package each file belongs to: the deepest package manifest above it.
  const packageDirs = [...new Set(["", ...input.packageDirs])];
  const packageOf = (path: string) =>
    packageDirs
      .filter((d) => inside(path, d))
      .reduce((a, b) => (b.length > a.length ? b : a), "");
  const declared = new Set(
    input.roots.filter(declaresEntries).map((r) => packageOf(r.file)),
  );
  const importersOf = new Map<string, Set<string>>();
  for (const e of input.graph.edges) {
    if (!REACHABILITY_EDGE_KINDS.has(e.kind) || e.source === e.target) continue;
    const set = importersOf.get(e.target) ?? new Set<string>();
    set.add(e.source);
    importersOf.set(e.target, set);
  }
  // Strong hints linking an unreached node to a reached one, either way:
  // the file may be used in a way the imports do not show (M6, ADR-008).
  const strongHints = new Map<string, { other: string; edge: GraphEdge }[]>();
  for (const e of input.graph.edges) {
    if (!isHintEdge(e) || e.confidence < input.hintThreshold) continue;
    for (const [mine, other] of [
      [e.source, e.target],
      [e.target, e.source],
    ] as const) {
      if (reached.has(mine) || !reached.has(other)) continue;
      const list = strongHints.get(mine) ?? [];
      list.push({ other, edge: e });
      strongHints.set(mine, list);
    }
  }
  const rootCounts = new Map<string, number>();
  for (const r of input.roots)
    rootCounts.set(r.reason, (rootCounts.get(r.reason) ?? 0) + 1);
  const rootSummary = [...rootCounts]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([reason, n]) => `${String(n)} ${reason}`)
    .join(", ");

  const out: Finding[] = [];
  for (const [head, ids] of groups) {
    const files = ids.flatMap((id) => filesOf.get(id) ?? []).sort();
    const subject = files[0] ?? head;
    const caps: RubricCap[] = [];
    const caveats = [UNREACHABLE_CAVEAT];
    const evidence: string[] = [];
    let recency: string | undefined;

    const how = ids
      .map((id) => maybeLoaded.get(id))
      .find(
        (m) => m !== undefined && (m.via === undefined || !ids.includes(m.via)),
      );
    if (how !== undefined) {
      const importer =
        how.via === undefined ? "" : `It is imported by \`${how.via}\`, which `;
      if (how.by === "prefix") {
        caps.push("dynamic-import-prefix");
        caveats.push(
          how.via === undefined
            ? `A dynamic import or a path resolved at run time with the prefix \`${how.prefix}\` may load it.`
            : `${importer}a dynamic import or a path resolved at run time with the prefix \`${how.prefix}\` may load.`,
        );
      } else {
        const fw = how.framework;
        caps.push("framework-convention");
        caveats.push(
          `${how.via === undefined ? `${fw.name} loads files in this location` : `${importer}${fw.name} loads`} by convention (${fw.evidence}). Add the files it loads to entryPoints in epoch.config.json.`,
        );
      }
    }
    if (!declared.has(packageOf(subject))) {
      caps.push("convention-roots-only");
      caveats.push(
        "Its package declares no entry point in a manifest (such as package.json main, exports or bin) or in entryPoints in epoch.config.json, so its entry points come from scripts, tool configuration, naming conventions and tests. Listing them in entryPoints makes this more reliable.",
      );
    }
    if (input.historyStatus !== "usable" || input.history === undefined) {
      caps.push("history-unusable");
      caveats.push(HISTORY_CAVEAT[input.historyStatus]);
    } else {
      let newest: Date | undefined;
      for (const f of files) {
        const touched = await input.history.lastTouchedFile(f);
        const t = touched ?? input.now; // not in history: new work
        if (newest === undefined || t > newest) newest = t;
      }
      if (newest !== undefined) {
        const age = daysBetween(newest, input.now);
        if (age < input.staleAfterDays) {
          caps.push("recently-touched");
          caveats.push(
            `It changed ${plural(age, "day")} ago, so it may be new work that is not wired in yet.`,
          );
        } else {
          recency = `Last changed ${plural(age, "day")} ago.`;
        }
      }
    }

    const hint = ids
      .flatMap((id) => strongHints.get(id) ?? [])
      .sort(
        (a, b) =>
          b.edge.confidence - a.edge.confidence ||
          (a.other < b.other ? -1 : a.other > b.other ? 1 : 0),
      )[0];
    if (hint !== undefined) {
      caps.push("strong-hint");
      caveats.push(
        `A likely relation links it to \`${hint.other}\`, which an entry point reaches (${hintSourceLabel(hint.edge)}, confidence ${hint.edge.confidence.toFixed(2)}: ${hint.edge.evidence.join("; ")}), so it may be used in a way imports do not show.`,
      );
    }

    const outside = [
      ...new Set(
        ids.flatMap((id) =>
          [...(importersOf.get(id) ?? [])].filter((s) => !ids.includes(s)),
        ),
      ),
    ].sort();
    if (ids.length > 1) {
      evidence.unshift(
        `Its ${plural(files.length, "file")} import each other, but no entry point reaches any of them.`,
      );
    } else if (head.startsWith("pkg:")) {
      evidence.unshift(
        `No entry point reaches package \`${head.slice(4)}\` (${plural(files.length, "file")}) through imports.`,
      );
    } else {
      evidence.unshift("No entry point reaches it through imports.");
    }
    evidence.push(
      outside.length === 0
        ? "Nothing in the analyzed code imports it."
        : `Only imported by code that is not reached either: ${listSome(outside)}.`,
    );
    evidence.push(
      input.roots.length === 0
        ? "No entry points were found."
        : `Checked from ${plural(input.roots.length, "entry point")} (${rootSummary}).`,
    );
    if (recency !== undefined) evidence.push(recency);

    const rubric = applyCaps("high", caps);
    out.push({
      id: input.hash(`unreachable-file\u0000${subject}`),
      kind: "unreachable-file",
      subject: { type: "file", name: subject },
      confidence: rubric.confidence,
      locations: files.map((file) => ({ file })),
      evidence,
      caveats,
      suggestedAction:
        files.length > 1
          ? "These files look unused. If nothing outside the analyzed code loads them (tooling, configuration, reflection), they may be safe to remove. Check before deleting."
          : "This file looks unused. If nothing outside the analyzed code loads it (tooling, configuration, reflection), it may be safe to remove. Check before deleting.",
      caps: rubric.caps,
    });
  }
  return out;
}
