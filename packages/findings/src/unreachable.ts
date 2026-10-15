import {
  REACHABILITY_EDGE_KINDS,
  applyCaps,
  stronglyConnectedComponents,
  type EntryPoint,
  type Finding,
  type GitHistoryProvider,
  type Graph,
  type RubricCap,
} from "@epoch-dev/core";
import { frameworkMatcher, type DetectedFramework } from "./frameworks.js";
import { daysBetween, listSome, plural, type FindingsFile } from "./input.js";

/*
 * unreachable-file (CLAUDE.md "Unreachable files"): files no entry point
 * reaches over fact edges (all kinds, via-barrel and type-only included).
 * A cycle no root reaches, and a Go package, are one finding each.
 */

export const UNREACHABLE_CAVEAT =
  "Not referenced by analyzed code; may be loaded by tooling, reflection, or runtime configuration.";

const DECLARATION = /\.d\.[cm]?ts$|\.pyi$/;
const ROOT_REASONS_WITH_MANIFEST = new Set<EntryPoint["reason"]>([
  "manifest",
  "script",
  "config",
]);

const dirOf = (p: string): string =>
  p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const inside = (path: string, dir: string): boolean =>
  dir === "" || path.startsWith(`${dir}/`);

export interface UnreachableInput {
  readonly graph: Graph;
  readonly files: readonly FindingsFile[];
  readonly packages: ReadonlyMap<string, readonly string[]>;
  readonly roots: readonly EntryPoint[];
  readonly projectDirs: readonly string[];
  readonly frameworks: readonly DetectedFramework[];
  readonly suppressed: (path: string) => boolean;
  readonly history?: GitHistoryProvider;
  readonly historyUsable: boolean;
  readonly now: Date;
  readonly staleAfterDays: number;
  readonly hash: (text: string) => string;
}

/**
 * Node ids reached from the roots. Python adds one rule: importing a module
 * runs the __init__.py of every package above it, so those are reached too.
 */
function reachedNodes(
  input: UnreachableInput,
  nodeOf: (file: string) => string,
): Set<string> {
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
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of input.roots) {
    const id = nodeOf(r.file);
    if (!seen.has(id)) {
      seen.add(id);
      queue.push(id);
    }
  }
  for (const current of queue) {
    for (const next of adj.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

export async function unreachableFindings(
  input: UnreachableInput,
): Promise<Finding[]> {
  const memberOf = new Map<string, string>();
  for (const [pkg, members] of input.packages) {
    for (const m of members) memberOf.set(m, pkg);
  }
  const nodeOf = (file: string) => memberOf.get(file) ?? file;
  const reached = reachedNodes(input, nodeOf);
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
  const projectDirs = [...new Set(["", ...input.projectDirs])];
  const projectOf = (path: string) =>
    projectDirs
      .filter((d) => inside(path, d))
      .reduce((a, b) => (b.length > a.length ? b : a), "");
  const importersOf = new Map<string, Set<string>>();
  for (const e of input.graph.edges) {
    if (!REACHABILITY_EDGE_KINDS.has(e.kind) || e.source === e.target) continue;
    const set = importersOf.get(e.target) ?? new Set<string>();
    set.add(e.source);
    importersOf.set(e.target, set);
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

    const covering = prefixes.find((p) => files.some((f) => f.startsWith(p)));
    if (covering !== undefined) {
      caps.push("dynamic-import-prefix");
      caveats.push(
        `A dynamic import with the path prefix \`${covering}\` may load it at run time.`,
      );
    }
    const fw = files.map(framework).find((d) => d !== undefined);
    if (fw !== undefined) {
      caps.push("framework-convention");
      caveats.push(
        `${fw.name} loads files in this location by convention (${fw.evidence}). Add the files it loads to entryPoints in epoch.config.json.`,
      );
    }
    const project = projectOf(subject);
    const manifestRoots = input.roots.some(
      (r) =>
        ROOT_REASONS_WITH_MANIFEST.has(r.reason) && inside(r.file, project),
    );
    if (!manifestRoots) {
      caps.push("convention-roots-only");
      caveats.push(
        "No manifest or config entry point was found for this project, so its entry points come from naming conventions and tests. Listing them in entryPoints in epoch.config.json makes this more reliable.",
      );
    }
    if (!input.historyUsable || input.history === undefined) {
      caps.push("history-unusable");
      caveats.push(
        "Git history was not available, so recent changes could not be checked.",
      );
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
