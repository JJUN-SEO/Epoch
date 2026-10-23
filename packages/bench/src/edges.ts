import type { RawImport, Resolution } from "@epoch-dev/core";
import { packageName } from "@epoch-dev/adapter-typescript";
import { exportTargets } from "./reference.js";

/** A file-level edge key. */
export const edgeKey = (from: string, to: string): string =>
  `${from}\u0000${to}`;

/** One import as Epoch resolved it. */
export interface EpochImport {
  readonly from: string;
  readonly specifier: string | null;
  readonly kind: RawImport["kind"];
  readonly res: Resolution;
  /** A file its line loads at run time by path (new URL(..., import.meta.url), require.resolve, path.join(__dirname, ...)), not an import. */
  readonly runtimePath?: boolean;
}

/** One dependency as the ground-truth tool reported it. */
export interface ToolDependency {
  readonly from: string;
  readonly specifier: string;
  /** Repo-relative file it resolved to, or null (unresolved, core module, node_modules). */
  readonly resolved: string | null;
  readonly couldNotResolve: boolean;
  readonly types: readonly string[];
}

export type Verdict =
  "tool-wrong" | "epoch-wrong" | "ambiguous" | "unclassified";

export interface Disagreement {
  readonly side: "epoch-only" | "tool-only";
  readonly from: string;
  readonly to: string;
  readonly specifiers: readonly string[];
  readonly verdict: Verdict;
  readonly reason: string;
}

export interface ComparisonContext {
  /** Workspace packages by name: repo-relative directory and package.json `exports`. */
  readonly workspacePackages: ReadonlyMap<
    string,
    { readonly dir: string; readonly exports: unknown }
  >;
  /** Every package.json: its name (if any), repo-relative directory ("" for the root) and `imports` keys. */
  readonly packages: readonly {
    name?: string;
    dir: string;
    imports: readonly string[];
  }[];
  /** `paths` patterns of every tsconfig: the declaring tsconfig's directory, and whether it sets `baseUrl`. */
  readonly aliases: readonly {
    pattern: string;
    dir: string;
    baseUrl: boolean;
  }[];
}

export interface Comparison {
  readonly epochEdges: number;
  readonly toolEdges: number;
  readonly both: number;
  readonly disagreements: readonly Disagreement[];
}

/** Matches a specifier against a tsconfig `paths` pattern (one optional `*`). */
export function matchesAlias(spec: string, pattern: string): boolean {
  const star = pattern.indexOf("*");
  return star === -1
    ? spec === pattern
    : spec.length >= pattern.length - 1 &&
        spec.startsWith(pattern.slice(0, star)) &&
        spec.endsWith(pattern.slice(star + 1));
}

const TS_SIBLING = /(?:\.d)?\.[cm]?tsx?$/;
const JS_SIBLING = /\.[cm]?jsx?$/;

/**
 * Two files that are the TypeScript and JavaScript faces of one module:
 * `x.d.ts` or `x.ts` next to `x.js` (also `y.wasm.d.ts` next to `y.wasm`).
 * TypeScript resolution picks the former, runtime resolution the latter.
 */
export function areSiblings(a: string, b: string): boolean {
  const ts = TS_SIBLING.test(a) ? a : TS_SIBLING.test(b) ? b : undefined;
  if (ts === undefined) return false;
  const other = ts === a ? b : a;
  if (TS_SIBLING.test(other)) return false;
  const stem = ts.replace(TS_SIBLING, "");
  return other.replace(JS_SIBLING, "") === stem || other === stem;
}

const SIBLINGS =
  "TypeScript resolution picks the declaration or TS source next to the JS file; the tool picks the JS file";

/** `./x?raw`, `./a.css#hash`: a bundler query or fragment after the path. */
const QUERY = /.[?#]/;

const within = (file: string, dir: string) =>
  dir === "" || file.startsWith(`${dir}/`);

/** The TypeScript faces of an export target: TypeScript tries x.ts and x.d.ts for x.js. */
function tsFaces(target: string): string[] {
  const m = /^(.*)\.([cm]?)js(x?)$/.exec(target);
  if (!m) return [target];
  const [, stem = "", flavor = "", x = ""] = m;
  return [
    target,
    `${stem}.${flavor}ts${x}`,
    ...(x === "" ? [`${stem}.d.${flavor}ts`, `${stem}.tsx`] : []),
  ];
}

/**
 * The repo files a workspace package exports for a specifier's subpath,
 * under any condition, with TypeScript's .ts faces of .js targets; undefined
 * when the specifier names no workspace package.
 */
function ownExports(
  spec: string,
  ctx: ComparisonContext,
): Set<string> | undefined {
  const name = packageName(spec);
  const workspace = ctx.workspacePackages.get(name);
  if (!workspace) return undefined;
  const subpath = `.${spec.slice(name.length)}`;
  return new Set(
    exportTargets(workspace.exports, subpath)
      .flatMap(tsFaces)
      .map((t) => (workspace.dir === "" ? t : `${workspace.dir}/${t}`)),
  );
}

const BOTH_EXPORTED =
  "the workspace package exports both files for this subpath; which one applies depends on the export conditions in effect";

/** Why the tool could not resolve a specifier Epoch resolved, when the cause is certain. */
function toolMiss(
  from: string,
  spec: string,
  to: string,
  ctx: ComparisonContext,
): string | undefined {
  const name = packageName(spec);
  const own = ownExports(spec, ctx);
  if (own) {
    // The tool has the package linked, so it failed on the exports: under
    // this file's tsconfig they point at build output that is not there.
    // Epoch's target counts only if the package itself exports that file
    // for this subpath (under its own source condition).
    return own.has(to)
      ? "workspace package: under this file's tsconfig its exports point at unbuilt output; Epoch's target is the package's own export for this subpath"
      : undefined;
  }
  if (ctx.packages.some((p) => p.name === name && within(from, p.dir))) {
    return "package self-reference through its own package.json exports";
  }
  const alias = ctx.aliases.find(
    (a) => within(from, a.dir) && matchesAlias(spec, a.pattern),
  );
  if (alias) {
    // Checked on zod's docs: the same tsconfig with a baseUrl added resolves.
    return alias.baseUrl
      ? undefined
      : "tsconfig paths without baseUrl (TypeScript allows it since 4.1); the tool applies paths only with a baseUrl";
  }
  if (spec.startsWith("#")) {
    const owner = ctx.packages
      .filter((p) => within(from, p.dir))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
    if (owner?.imports.some((k) => matchesAlias(spec, k)) === true) {
      return "package.json subpath import (#…); the tool did not resolve it";
    }
  }
  if (QUERY.test(spec)) {
    return "bundler query suffix (?raw, ?worker); the file exists";
  }
  return undefined;
}

function classifyEpochOnly(
  from: string,
  to: string,
  ours: readonly EpochImport[],
  theirs: readonly ToolDependency[],
  ctx: ComparisonContext,
): Disagreement {
  const specs = ours
    .filter((i) => i.res.kind === "file" && i.res.target === to)
    .map((i) => i.specifier ?? "<non-literal>");
  const base = { side: "epoch-only" as const, from, to, specifiers: specs };
  for (const spec of specs) {
    const dep = theirs.find((d) => d.specifier === spec);
    if (!dep) continue;
    if (dep.couldNotResolve) {
      const reason = toolMiss(from, spec, to, ctx);
      return reason
        ? { ...base, verdict: "tool-wrong", reason }
        : {
            ...base,
            verdict: "unclassified",
            reason: "the tool could not resolve it",
          };
    }
    if (dep.resolved !== null && dep.resolved !== to) {
      const own = ownExports(spec, ctx);
      if (own?.has(to) === true && own.has(dep.resolved))
        return { ...base, verdict: "ambiguous", reason: BOTH_EXPORTED };
      return areSiblings(to, dep.resolved)
        ? { ...base, verdict: "ambiguous", reason: SIBLINGS }
        : {
            ...base,
            verdict: "unclassified",
            reason: `the tool resolved it to ${dep.resolved}`,
          };
    }
  }
  const loaded = ours.filter(
    (i) => i.res.kind === "file" && i.res.target === to,
  );
  if (loaded.length > 0 && loaded.every((i) => i.runtimePath === true))
    return {
      ...base,
      verdict: "tool-wrong",
      reason:
        "a file loaded at run time by a literal path (new URL(..., import.meta.url), require.resolve, path.join(__dirname, ...)); the tool reads import statements and import() calls only",
    };
  return {
    ...base,
    verdict: "unclassified",
    reason: "the tool did not report this import",
  };
}

function classifyToolOnly(
  from: string,
  to: string,
  ours: readonly EpochImport[],
  theirs: readonly ToolDependency[],
  ctx: ComparisonContext,
): Disagreement {
  const deps = theirs.filter((d) => d.resolved === to);
  const base = {
    side: "tool-only" as const,
    from,
    to,
    specifiers: deps.map((d) => d.specifier),
  };
  for (const dep of deps) {
    const mine = ours.find((i) => i.specifier === dep.specifier);
    if (!mine) {
      const how = dep.types.includes("triple-slash-directive")
        ? "a triple-slash reference directive"
        : dep.types.includes("type-import")
          ? "an import() type"
          : `a ${dep.types.join("/")} dependency`;
      return {
        ...base,
        verdict: "epoch-wrong",
        reason: `Epoch does not extract ${how}`,
      };
    }
    if (mine.res.kind === "unresolved") {
      return mine.res.reason === "dynamic-specifier"
        ? {
            ...base,
            verdict: "ambiguous",
            reason: "non-literal dynamic import",
          }
        : {
            ...base,
            verdict: "epoch-wrong",
            reason: `Epoch left it unresolved (${mine.res.reason})`,
          };
    }
    if (mine.res.kind === "external") {
      return {
        ...base,
        verdict: "epoch-wrong",
        reason: `Epoch classified it as the external package ${mine.res.name}`,
      };
    }
    if (mine.res.kind === "file" && mine.res.target !== to) {
      const own = ownExports(dep.specifier, ctx);
      if (own?.has(to) === true && own.has(mine.res.target))
        return { ...base, verdict: "ambiguous", reason: BOTH_EXPORTED };
      return areSiblings(to, mine.res.target)
        ? { ...base, verdict: "ambiguous", reason: SIBLINGS }
        : {
            ...base,
            verdict: "unclassified",
            reason: `Epoch resolved it to ${mine.res.target}`,
          };
    }
  }
  return {
    ...base,
    verdict: "unclassified",
    reason: "no matching import found on either side",
  };
}

function groupByFrom<T extends { from: string }>(
  xs: readonly T[],
): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const list = m.get(x.from);
    if (list) list.push(x);
    else m.set(x.from, [x]);
  }
  return m;
}

/**
 * Compares physical file-level imports (what each tool resolved each import
 * to; Epoch's barrel tracing does not enter) from files both tools analyzed,
 * and classifies every disagreement by rule. Rules cover only causes that are
 * certain; anything else stays "unclassified" for a human to review
 * (PLAN.md Benchmark protocol).
 */
export function compareEdges(input: {
  readonly sources: ReadonlySet<string>;
  readonly epochImports: readonly EpochImport[];
  readonly toolDependencies: readonly ToolDependency[];
  readonly context: ComparisonContext;
}): Comparison {
  const epoch = new Set<string>();
  for (const i of input.epochImports) {
    if (i.res.kind === "file" && input.sources.has(i.from))
      epoch.add(edgeKey(i.from, i.res.target));
  }
  const tool = new Set<string>();
  for (const d of input.toolDependencies) {
    if (d.resolved !== null && input.sources.has(d.from))
      tool.add(edgeKey(d.from, d.resolved));
  }
  const ours = groupByFrom(input.epochImports);
  const theirs = groupByFrom(input.toolDependencies);
  const disagreements: Disagreement[] = [];
  let both = 0;
  for (const key of [...new Set([...epoch, ...tool])].sort()) {
    const [from = "", to = ""] = key.split("\u0000");
    const inEpoch = epoch.has(key);
    if (inEpoch && tool.has(key)) both++;
    else if (inEpoch) {
      disagreements.push(
        classifyEpochOnly(
          from,
          to,
          ours.get(from) ?? [],
          theirs.get(from) ?? [],
          input.context,
        ),
      );
    } else {
      disagreements.push(
        classifyToolOnly(
          from,
          to,
          ours.get(from) ?? [],
          theirs.get(from) ?? [],
          input.context,
        ),
      );
    }
  }
  return { epochEdges: epoch.size, toolEdges: tool.size, both, disagreements };
}

/**
 * Precision and recall. Raw: the tool is truth. Adjusted: against the
 * reference set R = agreed edges plus real edges only one side found;
 * ambiguous edges are left out and unclassified ones count against Epoch
 * (conservative) until reviewed.
 */
export function scores(c: Comparison): {
  raw: { precision: number; recall: number };
  adjusted: { precision: number; recall: number };
} {
  const count = (side: Disagreement["side"], verdicts: readonly Verdict[]) =>
    c.disagreements.filter(
      (d) => d.side === side && verdicts.includes(d.verdict),
    ).length;
  const realEpochOnly = count("epoch-only", ["tool-wrong"]);
  const falseEpochOnly = count("epoch-only", ["epoch-wrong", "unclassified"]);
  const missedByEpoch = count("tool-only", ["epoch-wrong", "unclassified"]);
  const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);
  return {
    raw: {
      precision: ratio(c.both, c.epochEdges),
      recall: ratio(c.both, c.toolEdges),
    },
    adjusted: {
      precision: ratio(
        c.both + realEpochOnly,
        c.both + realEpochOnly + falseEpochOnly,
      ),
      recall: ratio(
        c.both + realEpochOnly,
        c.both + realEpochOnly + missedByEpoch,
      ),
    },
  };
}
