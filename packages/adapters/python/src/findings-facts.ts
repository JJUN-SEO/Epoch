import type { Node } from "web-tree-sitter";
import type {
  ConstantCondition,
  ExtractorConfig,
  FlagUsage,
} from "@epoch-dev/core";

/*
 * The facts dead-feature findings need from a Python file (CLAUDE.md "Flag
 * detection", rubric "dead-branch"): flag usages and statically constant
 * conditions. One pass over the tree; anything uncertain is left out.
 */

const lineOf = (n: Node): number => n.startPosition.row + 1;
const endLineOf = (n: Node): number => n.endPosition.row + 1;

/** A plain string literal's value (raw text between the quotes), or null (f-strings, non-strings). */
function literal(n: Node | undefined): string | null {
  if (n?.type !== "string") return null;
  if (n.namedChildren.some((c) => c.type === "interpolation")) return null;
  const start = n.namedChildren.find((c) => c.type === "string_start");
  const end = n.namedChildren.find((c) => c.type === "string_end");
  if (!start || !end || /f/i.test(start.text)) return null;
  return n.text.slice(start.text.length, n.text.length - end.text.length);
}

/** Identifiers bound by an assignment target (names, tuples, lists). */
function targetNames(t: Node | null, out: string[]): void {
  if (!t) return;
  if (t.type === "identifier") out.push(t.text);
  else if (
    t.type === "pattern_list" ||
    t.type === "tuple_pattern" ||
    t.type === "list_pattern" ||
    t.type === "list_splat_pattern"
  ) {
    for (const c of t.namedChildren) targetNames(c, out);
  }
}

/** Names this node binds (assignments, parameters, imports, loops, defs...). */
function bindings(n: Node): string[] {
  const out: string[] = [];
  switch (n.type) {
    case "assignment":
    case "augmented_assignment":
      targetNames(n.childForFieldName("left"), out);
      break;
    case "for_statement":
    case "for_in_clause":
      targetNames(n.childForFieldName("left"), out);
      break;
    case "as_pattern_target":
    case "list_splat_pattern":
    case "dictionary_splat_pattern":
      targetNames(n.namedChild(0), out);
      break;
    case "parameters":
    case "lambda_parameters":
      for (const c of n.namedChildren)
        if (c.type === "identifier") out.push(c.text);
      break;
    case "typed_parameter":
      for (const c of n.namedChildren)
        if (c.type === "identifier") out.push(c.text);
      break;
    case "default_parameter":
    case "typed_default_parameter":
    case "function_definition":
    case "class_definition":
    case "named_expression": {
      const name = n.childForFieldName("name");
      if (name?.type === "identifier") out.push(name.text);
      break;
    }
    case "aliased_import": {
      const alias = n.childForFieldName("alias");
      if (alias) out.push(alias.text);
      break;
    }
    case "import_statement":
    case "import_from_statement":
      for (const c of n.childrenForFieldName("name")) {
        if (c.type === "dotted_name") {
          const parts = c.namedChildren;
          const bound = n.type === "import_statement" ? parts[0] : parts.at(-1);
          if (bound) out.push(bound.text);
        }
      }
      break;
    default:
      break;
  }
  return out;
}

interface Constant {
  readonly value: boolean;
  readonly scope: "local" | "module" | "exported";
}

interface Evaluated {
  readonly value: boolean;
  readonly name: string | null;
  readonly scope: ConstantCondition["scope"];
}

/** Typing-only guards are never constant conditions (CLAUDE.md rubric). */
const TYPING_GUARD = new Set(["TYPE_CHECKING", "__debug__"]);

/**
 * Flag usages and constant conditions of one Python file.
 * `imports` are the file's imported module names (for a pattern's importHints).
 */
export function findingsFacts(
  root: Node,
  imports: readonly string[],
  cfg: ExtractorConfig,
): { flagUsages: FlagUsage[]; constantConditions: ConstantCondition[] } {
  const nodes: Node[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) break;
    nodes.push(n);
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }

  const bound = new Map<string, number>();
  const rebound = new Set<string>(); // global/nonlocal declarations
  for (const n of nodes) {
    for (const name of bindings(n)) bound.set(name, (bound.get(name) ?? 0) + 1);
    if (n.type === "global_statement" || n.type === "nonlocal_statement") {
      for (const c of n.namedChildren) rebound.add(c.text);
    }
  }
  const constants = new Map<string, Constant>();
  for (const n of nodes) {
    if (n.type !== "assignment") continue;
    const left = n.childForFieldName("left");
    const right = n.childForFieldName("right");
    if (
      left?.type !== "identifier" ||
      (right?.type !== "true" && right?.type !== "false")
    ) {
      continue;
    }
    let local = false;
    let inClass = false;
    for (let a = n.parent; a; a = a.parent) {
      if (a.type === "function_definition" || a.type === "lambda") local = true;
      if (a.type === "class_definition" && !local) inClass = true;
    }
    if (inClass) continue; // class attributes can be overridden per instance
    constants.set(left.text, {
      value: right.type === "true",
      scope: local
        ? "local"
        : left.text.startsWith("_")
          ? "module"
          : "exported",
    });
  }

  const evaluate = (e: Node | null): Evaluated | undefined => {
    if (!e) return undefined;
    if (e.type === "true" || e.type === "false") {
      return { value: e.type === "true", name: null, scope: "literal" };
    }
    if (e.type === "parenthesized_expression") return evaluate(e.namedChild(0));
    if (e.type === "not_operator") {
      const inner = evaluate(e.childForFieldName("argument"));
      return inner && { ...inner, value: !inner.value };
    }
    if (e.type === "identifier") {
      if (TYPING_GUARD.has(e.text)) return undefined;
      const c = constants.get(e.text);
      if (!c || bound.get(e.text) !== 1 || rebound.has(e.text))
        return undefined;
      return { value: c.value, name: e.text, scope: c.scope };
    }
    return undefined;
  };

  const constantConditions: ConstantCondition[] = [];
  const push = (
    site: Node,
    v: Evaluated,
    dead: readonly Node[],
    deadBranch: "then" | "else",
  ) => {
    const last = dead.at(-1);
    if (!last) return;
    constantConditions.push({
      name: v.name,
      value: v.value,
      scope: v.scope,
      line: lineOf(site),
      endLine: endLineOf(last),
      deadBranch,
    });
  };
  const flagUsages: FlagUsage[] = [];
  const patterns = cfg.flagPatterns.filter((p) => p.language === "python");
  const imported = (hints: readonly string[]) =>
    hints.some((h) => imports.some((s) => s === h || s.startsWith(`${h}.`)));
  const wrappers = new Set(cfg.wrapperFunctions);
  const envName = (key: string | null) =>
    key !== null && cfg.envPrefixes.some((p) => key.startsWith(p))
      ? key
      : undefined;
  const isOsEnviron = (n: Node | null) =>
    n?.type === "attribute" &&
    n.childForFieldName("object")?.text === "os" &&
    n.childForFieldName("attribute")?.text === "environ";

  for (const n of nodes) {
    if (n.type === "if_statement" || n.type === "elif_clause") {
      const v = evaluate(n.childForFieldName("condition"));
      if (!v) continue;
      const consequence = n.childForFieldName("consequence");
      if (!v.value) {
        if (consequence) push(n, v, [consequence], "then");
        continue;
      }
      // True: the clauses after this one never run.
      const later: Node[] =
        n.type === "if_statement"
          ? n.childrenForFieldName("alternative")
          : (() => {
              const out: Node[] = [];
              for (let s = n.nextNamedSibling; s; s = s.nextNamedSibling) {
                if (s.type === "elif_clause" || s.type === "else_clause")
                  out.push(s);
              }
              return out;
            })();
      push(n, v, later, "else");
    } else if (n.type === "conditional_expression") {
      const [consequence, condition, alternative] = n.namedChildren;
      const v = evaluate(condition ?? null);
      const dead = v && (v.value ? alternative : consequence);
      if (v && dead) push(n, v, [dead], v.value ? "else" : "then");
    } else if (n.type === "call") {
      const fn = n.childForFieldName("function");
      const callee =
        fn?.type === "identifier"
          ? fn.text
          : fn?.type === "attribute"
            ? fn.childForFieldName("attribute")?.text
            : undefined;
      if (callee === undefined) continue;
      const args = (
        n.childForFieldName("arguments")?.namedChildren ?? []
      ).filter((a) => a.type !== "keyword_argument" && a.type !== "comment");
      const pattern = patterns.find((p) => p.callee === callee);
      // os.getenv("X") and os.environ.get("X")
      const env =
        fn?.type === "attribute" &&
        ((callee === "getenv" &&
          fn.childForFieldName("object")?.text === "os") ||
          (callee === "get" && isOsEnviron(fn.childForFieldName("object"))))
          ? envName(literal(args[0]))
          : undefined;
      if (pattern) {
        flagUsages.push({
          flagName: literal(args[pattern.keyArgIndex]),
          line: lineOf(n),
          endLine: endLineOf(n),
          detection: "sdk-call",
          strength: imported(pattern.importHints) ? "strong" : "weak",
          provider: pattern.provider,
          patternId: pattern.id,
        });
      } else if (wrappers.has(callee)) {
        flagUsages.push({
          flagName: literal(args[0]),
          line: lineOf(n),
          endLine: endLineOf(n),
          detection: "wrapper-call",
          strength: "strong",
        });
      } else if (env !== undefined) {
        flagUsages.push({
          flagName: env,
          line: lineOf(n),
          endLine: endLineOf(n),
          detection: "env-read",
          strength: "strong",
        });
      }
    } else if (
      n.type === "subscript" &&
      isOsEnviron(n.childForFieldName("value"))
    ) {
      // os.environ["X"]
      const name = envName(
        literal(n.childForFieldName("subscript") ?? undefined),
      );
      if (name !== undefined) {
        flagUsages.push({
          flagName: name,
          line: lineOf(n),
          endLine: endLineOf(n),
          detection: "env-read",
          strength: "strong",
        });
      }
    }
  }
  return { flagUsages, constantConditions };
}
