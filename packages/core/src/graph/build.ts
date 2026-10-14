import { canonicalizeGraph, compareCodeUnits } from "../canonical.js";
import { CERTAIN_EDGE_KINDS } from "../policy.js";
import {
  GRAPH_SCHEMA_VERSION,
  type EdgeKind,
  type FileFacts,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type RawImport,
  type Resolution,
  type UnresolvedImport,
} from "../schemas/index.js";

/** One analyzed file: its facts plus the resolution of each of its imports. */
export interface FileInput {
  /** Node id: repo-relative path with forward slashes. */
  readonly id: string;
  readonly language: string;
  readonly loc: number;
  readonly contentHash: string;
  readonly facts: FileFacts;
  /** One entry per facts.imports element, re-exports included. */
  readonly resolutions: readonly { imp: RawImport; res: Resolution }[];
}

/** Result of looking an exported name up through re-exports. */
type Lookup =
  | { kind: "found"; file: string }
  /** The module definitely does not export the name. */
  | { kind: "absent" }
  /** Cannot be decided conservatively (cycle, unresolved source, ambiguity, unknown file). */
  | { kind: "unknown" };

const FOUND = (file: string): Lookup => ({ kind: "found", file });
const ABSENT: Lookup = { kind: "absent" };
const UNKNOWN: Lookup = { kind: "unknown" };

interface FileIndex {
  readonly locals: ReadonlySet<string>;
  /** Named re-exports by exported name. */
  readonly named: ReadonlyMap<string, { specifier: string; imported: string }>;
  readonly stars: readonly string[];
  /** Re-export specifier -> resolved file id (absent if it did not resolve to a file). */
  readonly reexportTargets: ReadonlyMap<string, string>;
  readonly isBarrel: boolean;
}

function indexFile(f: FileInput): FileIndex {
  const locals = new Set<string>();
  const named = new Map<string, { specifier: string; imported: string }>();
  for (const e of f.facts.exports) {
    if (e.from) named.set(e.name, e.from);
    else locals.add(e.name);
  }
  const reexportTargets = new Map<string, string>();
  for (const { imp, res } of f.resolutions) {
    if (imp.kind !== "reexport" || imp.specifier === null) continue;
    if (res.kind === "file" || res.kind === "package") {
      reexportTargets.set(imp.specifier, res.target);
    }
  }
  return {
    locals,
    named,
    stars: f.facts.exportAllFrom,
    reexportTargets,
    isBarrel: named.size > 0 || f.facts.exportAllFrom.length > 0,
  };
}

/**
 * Builds the file-level graph and applies the Barrel transparency rule
 * (CLAUDE.md): an import of named exports through a barrel B becomes an edge
 * to each declaring file C (`via barrel B`), plus one `via-barrel` edge to B.
 * Anything that cannot be traced conservatively stays a direct edge to B.
 * Fan-in and fan-out count distinct direct neighbours over certain edges.
 * Pure: the same inputs always give the same (canonical) graph.
 */
export function buildGraph(files: readonly FileInput[]): Graph {
  const byId = new Map(files.map((f) => [f.id, f]));
  const indexes = new Map(files.map((f) => [f.id, indexFile(f)]));

  const lookup = (
    fileId: string,
    name: string,
    visited: ReadonlySet<string>,
  ): Lookup => {
    const ix = indexes.get(fileId);
    if (!ix || visited.has(fileId)) return UNKNOWN;
    if (ix.locals.has(name)) return FOUND(fileId);
    const next = new Set(visited).add(fileId);
    const reexport = ix.named.get(name);
    if (reexport) {
      const target = ix.reexportTargets.get(reexport.specifier);
      if (target === undefined) return UNKNOWN;
      if (reexport.imported === "*") return FOUND(target); // export * as name from
      const r = lookup(target, reexport.imported, next);
      return r.kind === "found" ? r : UNKNOWN; // a broken re-export cannot be traced
    }
    // `export *` never re-exports `default` (ECMAScript module semantics).
    if (name === "default") return ABSENT;
    const hits = new Set<string>();
    let unknown = false;
    for (const spec of ix.stars) {
      const target = ix.reexportTargets.get(spec);
      if (target === undefined) {
        unknown = true;
        continue;
      }
      const r = lookup(target, name, next);
      if (r.kind === "found") hits.add(r.file);
      else if (r.kind === "unknown") unknown = true;
    }
    if (unknown || hits.size > 1) return UNKNOWN; // ambiguous stars are dropped, as TS does
    const [only] = hits;
    return only === undefined ? ABSENT : FOUND(only);
  };

  const edges = new Map<
    string,
    { edge: Omit<GraphEdge, "evidence">; evidence: Set<string> }
  >();
  const addEdge = (
    source: string,
    target: string,
    kind: EdgeKind,
    evidence?: string,
  ) => {
    const key = `${source}\u0000${target}\u0000${kind}`;
    let entry = edges.get(key);
    if (!entry) {
      entry = {
        edge: { source, target, kind, provenance: "resolver", confidence: 1 },
        evidence: new Set(),
      };
      edges.set(key, entry);
    }
    if (evidence !== undefined) entry.evidence.add(evidence);
  };

  const externals = new Map<string, Set<string>>(
    files.map((f) => [f.id, new Set()]),
  );
  const unresolved: UnresolvedImport[] = [];

  for (const f of files) {
    for (const { imp, res } of f.resolutions) {
      if (res.kind === "external") {
        externals.get(f.id)?.add(res.name);
        continue;
      }
      if (res.kind === "unresolved") {
        unresolved.push({
          from: f.id,
          specifier: imp.specifier,
          reason: res.reason,
          ...(res.pathPrefix !== undefined
            ? { pathPrefix: res.pathPrefix }
            : {}),
          line: imp.line,
        });
        continue;
      }
      const target = res.target;
      if (!byId.has(target)) {
        throw new Error(
          `buildGraph: ${f.id} resolves ${JSON.stringify(imp.specifier)} to ${target}, which is not among the analyzed files`,
        );
      }
      if (imp.kind === "reexport") {
        addEdge(f.id, target, "reexport");
        continue;
      }
      if (imp.kind === "dynamic") {
        addEdge(f.id, target, "dynamic-import");
        continue;
      }
      const kind: EdgeKind = imp.typeOnly ? "type-only" : "import";
      const names = imp.names.map((n) => n.imported);
      const targetIx = indexes.get(target);
      const traceable =
        imp.kind !== "side-effect" &&
        names.length > 0 &&
        !names.includes("*") &&
        targetIx?.isBarrel === true;
      if (!traceable) {
        addEdge(f.id, target, kind);
        continue;
      }
      let direct = false;
      let traced = false;
      for (const name of names) {
        const r = lookup(target, name, new Set());
        if (r.kind === "found" && r.file !== target) {
          addEdge(f.id, r.file, kind, `via barrel ${target}`);
          traced = true;
        } else {
          direct = true;
        }
      }
      if (traced) addEdge(f.id, target, "via-barrel");
      if (direct) addEdge(f.id, target, kind);
    }
  }

  const edgeList: GraphEdge[] = [...edges.values()].map(
    ({ edge, evidence }) => ({
      ...edge,
      evidence: [...evidence].sort(compareCodeUnits),
    }),
  );

  const fanOut = new Map<string, Set<string>>();
  const fanIn = new Map<string, Set<string>>();
  for (const e of edgeList) {
    if (!CERTAIN_EDGE_KINDS.has(e.kind) || e.source === e.target) continue;
    (
      fanOut.get(e.source) ?? fanOut.set(e.source, new Set()).get(e.source)
    )?.add(e.target);
    (fanIn.get(e.target) ?? fanIn.set(e.target, new Set()).get(e.target))?.add(
      e.source,
    );
  }

  const nodes: GraphNode[] = files.map((f) => ({
    id: f.id,
    kind: "file",
    language: f.language,
    loc: f.loc,
    contentHash: f.contentHash,
    exports: [...new Set(f.facts.exports.map((e) => e.name))],
    externals: [...(externals.get(f.id) ?? [])],
    flags: f.facts.flagUsages,
    metrics: {
      fanIn: fanIn.get(f.id)?.size ?? 0,
      fanOut: fanOut.get(f.id)?.size ?? 0,
    },
  }));

  return canonicalizeGraph({
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodes,
    edges: edgeList,
    roots: [],
    findings: [],
    unresolved,
  });
}
