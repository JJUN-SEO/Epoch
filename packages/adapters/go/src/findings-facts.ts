import type { Node } from "web-tree-sitter";
import type {
  ConstantCondition,
  ExtractorConfig,
  FlagUsage,
} from "@epoch-dev/core";

/*
 * The facts dead-feature findings need from a Go file (CLAUDE.md "Flag
 * detection", rubric "dead-branch"): flag usages and conditions on boolean
 * constants. One pass over the tree; anything uncertain is left out.
 */

const lineOf = (n: Node): number => n.startPosition.row + 1;
const endLineOf = (n: Node): number => n.endPosition.row + 1;

/** A Go string literal's value, or null (not a literal, or escapes that do not decode). */
function literal(n: Node | undefined): string | null {
  if (!n) return null;
  const body = n.text.slice(1, -1);
  if (n.type === "raw_string_literal") return body.replace(/\r/g, "");
  if (n.type !== "interpreted_string_literal") return null;
  if (!body.includes("\\")) return body;
  try {
    const v: unknown = JSON.parse(`"${body}"`);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

const isExported = (name: string): boolean => /^\p{Lu}/u.test(name);

/** Names this node binds (constants, variables, parameters, functions, types...). */
function bindings(n: Node): string[] {
  switch (n.type) {
    case "const_spec":
    case "var_spec":
    case "parameter_declaration":
    case "variadic_parameter_declaration":
    case "type_spec":
      return n.childrenForFieldName("name").map((c) => c.text);
    case "function_declaration":
    case "method_declaration": {
      const name = n.childForFieldName("name");
      return name ? [name.text] : [];
    }
    case "short_var_declaration":
    case "range_clause": {
      const left = n.childForFieldName("left");
      return (left?.namedChildren ?? [])
        .filter((c) => c.type === "identifier")
        .map((c) => c.text);
    }
    default:
      return [];
  }
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

/**
 * Flag usages and constant conditions of one Go file.
 * `imports` are the file's import paths (for a pattern's importHints).
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
  for (const n of nodes) {
    for (const name of bindings(n)) bound.set(name, (bound.get(name) ?? 0) + 1);
  }
  const constants = new Map<string, Constant>();
  for (const n of nodes) {
    if (n.type !== "const_spec") continue;
    const names = n.childrenForFieldName("name");
    const values = n.childForFieldName("value")?.namedChildren ?? [];
    if (values.length !== names.length) continue; // implicit repetition (iota) is left out
    let local = false;
    for (let a = n.parent; a; a = a.parent) {
      if (
        a.type === "function_declaration" ||
        a.type === "method_declaration" ||
        a.type === "func_literal"
      ) {
        local = true;
      }
    }
    for (const [i, name] of names.entries()) {
      const v = values[i];
      if (v?.type !== "true" && v?.type !== "false") continue;
      constants.set(name.text, {
        value: v.type === "true",
        scope: local ? "local" : isExported(name.text) ? "exported" : "module",
      });
    }
  }

  const evaluate = (e: Node | null): Evaluated | undefined => {
    if (!e) return undefined;
    if (e.type === "true" || e.type === "false") {
      return { value: e.type === "true", name: null, scope: "literal" };
    }
    if (e.type === "parenthesized_expression") return evaluate(e.namedChild(0));
    if (e.type === "unary_expression" && e.child(0)?.type === "!") {
      const inner = evaluate(e.childForFieldName("operand"));
      return inner && { ...inner, value: !inner.value };
    }
    if (e.type === "identifier") {
      const c = constants.get(e.text);
      if (!c || bound.get(e.text) !== 1) return undefined;
      return { value: c.value, name: e.text, scope: c.scope };
    }
    return undefined;
  };

  const constantConditions: ConstantCondition[] = [];
  const flagUsages: FlagUsage[] = [];
  const patterns = cfg.flagPatterns.filter((p) => p.language === "go");
  const imported = (hints: readonly string[]) =>
    hints.some((h) => imports.some((s) => s === h || s.startsWith(`${h}/`)));
  const wrappers = new Set(cfg.wrapperFunctions);
  const envName = (key: string | null) =>
    key !== null && cfg.envPrefixes.some((p) => key.startsWith(p))
      ? key
      : undefined;

  for (const n of nodes) {
    if (n.type === "if_statement") {
      const v = evaluate(n.childForFieldName("condition"));
      if (!v) continue;
      const branch = n.childForFieldName(
        v.value ? "alternative" : "consequence",
      );
      if (!branch) continue;
      constantConditions.push({
        name: v.name,
        value: v.value,
        scope: v.scope,
        line: lineOf(n),
        endLine: endLineOf(branch),
        deadBranch: v.value ? "else" : "then",
      });
    } else if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      const callee =
        fn?.type === "identifier"
          ? fn.text
          : fn?.type === "selector_expression"
            ? fn.childForFieldName("field")?.text
            : undefined;
      if (callee === undefined) continue;
      const args = (
        n.childForFieldName("arguments")?.namedChildren ?? []
      ).filter((a) => a.type !== "comment");
      const pattern = patterns.find((p) => p.callee === callee);
      const env =
        fn?.type === "selector_expression" &&
        fn.childForFieldName("operand")?.text === "os" &&
        (callee === "Getenv" || callee === "LookupEnv")
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
    }
  }
  return { flagUsages, constantConditions };
}
