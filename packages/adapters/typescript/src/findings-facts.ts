import type { Node } from "web-tree-sitter";
import type {
  ConstantCondition,
  ExtractorConfig,
  FlagUsage,
} from "@epoch-dev/core";

/*
 * The facts dead-feature findings need from a TS/JS file (CLAUDE.md "Flag
 * detection", rubric "dead-branch"): flag usages and statically constant
 * conditions. One pass over the tree; anything uncertain is left out.
 */

const lineOf = (n: Node): number => n.startPosition.row + 1;
const endLineOf = (n: Node): number => n.endPosition.row + 1;

/** A string literal's value, or null (not a literal, or a template with substitutions). */
function literal(n: Node | undefined): string | null {
  if (!n) return null;
  if (n.type === "string") return n.text.slice(1, -1);
  if (
    n.type === "template_string" &&
    !n.namedChildren.some((c) => c.type === "template_substitution")
  ) {
    return n.text.slice(1, -1);
  }
  return null;
}

const FUNCTION_LIKE = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "generator_function_declaration",
  "generator_function",
  "class_body",
]);

/** Parents whose identifier children (in these fields) introduce a binding. */
const BINDING_PARENTS = new Set([
  "variable_declarator",
  "required_parameter",
  "optional_parameter",
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "function_expression",
  "import_specifier",
  "import_clause",
  "namespace_import",
  "catch_clause",
  "for_in_statement",
  "object_pattern",
  "array_pattern",
  "assignment_pattern",
  "rest_pattern",
  "pair_pattern",
]);

function isBinding(id: Node): boolean {
  const p = id.parent;
  if (!p) return false;
  if (p.type === "arrow_function")
    return p.childForFieldName("parameter")?.id === id.id;
  if (!BINDING_PARENTS.has(p.type)) return false;
  if (p.type === "variable_declarator")
    return p.childForFieldName("name")?.id === id.id;
  if (p.type === "pair_pattern")
    return p.childForFieldName("value")?.id === id.id;
  if (p.type === "assignment_pattern")
    return p.childForFieldName("left")?.id === id.id;
  if (p.type === "import_specifier") {
    const alias = p.childForFieldName("alias");
    return alias
      ? alias.id === id.id
      : p.childForFieldName("name")?.id === id.id;
  }
  if (p.type === "for_in_statement")
    return p.childForFieldName("left")?.id === id.id;
  if (
    p.type === "function_declaration" ||
    p.type === "generator_function_declaration" ||
    p.type === "class_declaration" ||
    p.type === "function_expression"
  ) {
    return p.childForFieldName("name")?.id === id.id;
  }
  return true;
}

/** Identifiers written to by an assignment, update or destructuring assignment. */
function assignedNames(target: Node | null, out: Set<string>): void {
  if (!target) return;
  if (target.type === "identifier") {
    out.add(target.text);
    return;
  }
  if (
    target.type === "array_pattern" ||
    target.type === "object_pattern" ||
    target.type === "parenthesized_expression"
  ) {
    for (const c of target.namedChildren) assignedNames(c, out);
  }
  if (target.type === "shorthand_property_identifier_pattern")
    out.add(target.text);
  if (target.type === "pair_pattern")
    assignedNames(target.childForFieldName("value"), out);
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
 * Flag usages and constant conditions of one TS/JS file.
 * `imports` are the file's import specifiers (for a pattern's importHints).
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

  // Declarations, writes and exports of each name, for constants.
  const declared = new Map<string, number>();
  const written = new Set<string>();
  const exportedNames = new Set<string>();
  const constants = new Map<string, Constant>();
  for (const n of nodes) {
    if (
      (n.type === "identifier" ||
        n.type === "shorthand_property_identifier_pattern") &&
      isBinding(n)
    ) {
      declared.set(n.text, (declared.get(n.text) ?? 0) + 1);
    } else if (
      n.type === "assignment_expression" ||
      n.type === "augmented_assignment_expression"
    ) {
      assignedNames(n.childForFieldName("left"), written);
    } else if (n.type === "update_expression") {
      assignedNames(n.childForFieldName("argument"), written);
    } else if (n.type === "export_specifier") {
      const name = n.childForFieldName("name")?.text;
      if (name !== undefined) exportedNames.add(name);
    }
  }
  for (const n of nodes) {
    if (n.type !== "variable_declarator") continue;
    const name = n.childForFieldName("name");
    const value = n.childForFieldName("value");
    if (
      name?.type !== "identifier" ||
      (value?.type !== "true" && value?.type !== "false")
    ) {
      continue;
    }
    const decl = n.parent;
    if (decl?.type !== "lexical_declaration") continue; // var is left out
    let local = false;
    for (let a = decl.parent; a; a = a.parent) {
      if (FUNCTION_LIKE.has(a.type)) local = true;
    }
    const exported =
      decl.parent?.type === "export_statement" || exportedNames.has(name.text);
    constants.set(name.text, {
      value: value.type === "true",
      scope: local ? "local" : exported ? "exported" : "module",
    });
  }

  const evaluate = (e: Node | null): Evaluated | undefined => {
    if (!e) return undefined;
    if (e.type === "true" || e.type === "false") {
      return { value: e.type === "true", name: null, scope: "literal" };
    }
    if (e.type === "parenthesized_expression") return evaluate(e.namedChild(0));
    if (e.type === "unary_expression" && e.child(0)?.type === "!") {
      const inner = evaluate(e.childForFieldName("argument"));
      return inner && { ...inner, value: !inner.value };
    }
    if (e.type === "identifier") {
      const c = constants.get(e.text);
      if (!c || declared.get(e.text) !== 1 || written.has(e.text))
        return undefined;
      return { value: c.value, name: e.text, scope: c.scope };
    }
    return undefined;
  };

  const constantConditions: ConstantCondition[] = [];
  const flagUsages: FlagUsage[] = [];
  const patterns = cfg.flagPatterns.filter((p) => p.language === "typescript");
  const imported = (hints: readonly string[]) =>
    hints.some((h) => imports.some((s) => s === h || s.startsWith(`${h}/`)));
  const wrappers = new Set(cfg.wrapperFunctions);
  const envKey = (name: string) =>
    cfg.envPrefixes.some((p) => name.startsWith(p)) ? name : undefined;

  for (const n of nodes) {
    if (n.type === "if_statement") {
      const v = evaluate(n.childForFieldName("condition"));
      if (!v) continue;
      const branch = v.value
        ? n.childForFieldName("alternative")
        : n.childForFieldName("consequence");
      if (!branch) continue;
      constantConditions.push({
        name: v.name,
        value: v.value,
        scope: v.scope,
        line: lineOf(n),
        endLine: endLineOf(branch),
        deadBranch: v.value ? "else" : "then",
      });
    } else if (n.type === "ternary_expression") {
      const v = evaluate(n.childForFieldName("condition"));
      const branch =
        v && n.childForFieldName(v.value ? "alternative" : "consequence");
      if (!v || !branch) continue;
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
          : fn?.type === "member_expression"
            ? fn.childForFieldName("property")?.text
            : undefined;
      if (callee === undefined) continue;
      const args = (
        n.childForFieldName("arguments")?.namedChildren ?? []
      ).filter((a) => a.type !== "comment");
      const pattern = patterns.find((p) => p.callee === callee);
      const key = pattern
        ? literal(args[pattern.keyArgIndex])
        : literal(args[0]);
      if (key === "") continue; // an empty key is not a flag
      if (pattern) {
        flagUsages.push({
          flagName: key,
          line: lineOf(n),
          endLine: endLineOf(n),
          detection: "sdk-call",
          strength: imported(pattern.importHints) ? "strong" : "weak",
          provider: pattern.provider,
          patternId: pattern.id,
        });
      } else if (wrappers.has(callee)) {
        flagUsages.push({
          flagName: key,
          line: lineOf(n),
          endLine: endLineOf(n),
          detection: "wrapper-call",
          strength: "strong",
        });
      }
    } else if (
      n.type === "member_expression" ||
      n.type === "subscript_expression"
    ) {
      // process.env.X, process.env["X"], import.meta.env.X
      const obj = n.childForFieldName("object");
      const isEnv =
        obj?.type === "member_expression" &&
        obj.childForFieldName("property")?.text === "env" &&
        (obj.childForFieldName("object")?.text === "process" ||
          obj.childForFieldName("object")?.type === "meta_property");
      if (!isEnv) continue;
      const key =
        n.type === "member_expression"
          ? n.childForFieldName("property")?.text
          : (literal(n.childForFieldName("index") ?? undefined) ?? undefined);
      const name = key === undefined ? undefined : envKey(key);
      if (name === undefined) continue;
      flagUsages.push({
        flagName: name,
        line: lineOf(n),
        endLine: endLineOf(n),
        detection: "env-read",
        strength: "strong",
      });
    }
  }
  return { flagUsages, constantConditions };
}
