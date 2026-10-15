import { Query, type Language, type Node, type Tree } from "web-tree-sitter";
import type {
  ExportInfo,
  ExtractorConfig,
  FileFacts,
  ParsedFile,
  RawImport,
} from "@epoch-dev/core";
import { findingsFacts } from "./findings-facts.js";
import { IMPORTS_QUERY } from "./queries.generated.js";

const queries = new WeakMap<Language, Query>();

function queryFor(language: Language): Query {
  let q = queries.get(language);
  if (!q) {
    q = new Query(language, IMPORTS_QUERY);
    queries.set(language, q);
  }
  return q;
}

const lineOf = (n: Node): number => n.startPosition.row + 1;

/** "a.b.c" from a dotted_name, whatever whitespace the source put between the parts. */
const dotted = (n: Node): string =>
  n.namedChildren
    .filter((c) => c.type === "identifier")
    .map((c) => c.text)
    .join(".");

/** The module of a from-import as written: "x.y", ".", "..pkg". */
function moduleSpecifier(n: Node): string {
  if (n.type !== "relative_import") return dotted(n);
  const prefix =
    n.namedChildren
      .find((c) => c.type === "import_prefix")
      ?.text.replace(/\s/g, "") ?? "";
  const name = n.namedChildren.find((c) => c.type === "dotted_name");
  return prefix + (name ? dotted(name) : "");
}

const SCOPES = new Set(["function_definition", "class_definition", "lambda"]);

/** Not inside a function, class or lambda (if/try/with blocks still count). */
function atModuleLevel(n: Node): boolean {
  for (let p = n.parent; p; p = p.parent) if (SCOPES.has(p.type)) return false;
  return true;
}

/** `TYPE_CHECKING` or `<anything>.TYPE_CHECKING`. */
function isTypeChecking(n: Node): boolean {
  if (n.type === "identifier") return n.text === "TYPE_CHECKING";
  return (
    n.type === "attribute" &&
    n.childForFieldName("attribute")?.text === "TYPE_CHECKING"
  );
}

/** Inside the body of an `if TYPE_CHECKING:` block (not its else). */
function underTypeChecking(n: Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    const owner = p.parent;
    if (
      p.type === "block" &&
      owner?.type === "if_statement" &&
      owner.childForFieldName("consequence")?.equals(p) === true
    ) {
      const condition = owner.childForFieldName("condition");
      if (condition && isTypeChecking(condition)) return true;
    }
  }
  return false;
}

/** A plain string literal's value, or undefined (f-strings, bytes, escapes). */
function plainString(n: Node): string | undefined {
  if (n.type === "concatenated_string") {
    const parts = n.namedChildren.map(plainString);
    return parts.every((p) => p !== undefined) ? parts.join("") : undefined;
  }
  if (n.type !== "string") return undefined;
  const start = n.namedChildren.find((c) => c.type === "string_start");
  if (start && /[bBfF]/.test(start.text)) return undefined;
  const parts = n.namedChildren.filter(
    (c) => c.type !== "string_start" && c.type !== "string_end",
  );
  if (parts.some((c) => c.type !== "string_content")) return undefined;
  return parts.map((c) => c.text).join("");
}

/** The literal text before the first placeholder of an f-string or `"lit" + x`. */
function literalPrefix(n: Node): string | undefined {
  if (n.type === "binary_operator") {
    const left = n.childForFieldName("left");
    const op = n.childForFieldName("operator");
    if (op?.text !== "+" || !left) return undefined;
    return plainString(left) ?? literalPrefix(left);
  }
  if (n.type !== "string") return undefined;
  // Only an f-string has placeholders; a bytes literal is never a module name.
  const start = n.namedChildren.find((c) => c.type === "string_start");
  if (!start || !/[fF]/.test(start.text) || /[bB]/.test(start.text)) {
    return undefined;
  }
  let prefix = "";
  for (const c of n.namedChildren) {
    if (c.type === "string_start" || c.type === "string_end") continue;
    if (c.type !== "string_content") break;
    prefix += c.text;
  }
  return prefix === "" ? undefined : prefix;
}

/** The module-name argument of importlib.import_module(...) or __import__(...). */
function nameArgument(args: Node): Node | undefined {
  for (const c of args.namedChildren) {
    if (c.type === "keyword_argument") {
      if (c.childForFieldName("name")?.text === "name") {
        return c.childForFieldName("value") ?? undefined;
      }
      continue;
    }
    if (c.type === "comment") continue;
    return c;
  }
  return undefined;
}

/** `importlib.import_module`, `import_module`, `__import__` or `builtins.__import__`. */
function isDynamicImport(call: Node): boolean {
  const fn = call.childForFieldName("function");
  if (!fn) return false;
  if (fn.type === "identifier") {
    return fn.text === "import_module" || fn.text === "__import__";
  }
  if (fn.type !== "attribute") return false;
  const object = fn.childForFieldName("object")?.text;
  const attribute = fn.childForFieldName("attribute")?.text;
  return (
    (attribute === "import_module" && object === "importlib") ||
    (attribute === "__import__" && object === "builtins")
  );
}

interface Collected {
  readonly imports: RawImport[];
  readonly reexports: ExportInfo[];
  readonly exportAllFrom: string[];
}

function importStatement(n: Node, typeOnly: boolean, out: Collected): void {
  for (const name of n.childrenForFieldName("name")) {
    const target =
      name.type === "aliased_import" ? name.childForFieldName("name") : name;
    if (!target) continue;
    out.imports.push({
      kind: "static",
      specifier: dotted(target),
      typeOnly,
      names: [{ imported: "*" }],
      line: lineOf(n),
    });
  }
}

/**
 * One RawImport per imported name: whether `from X import n` reaches the
 * submodule X/n or a name in X depends on n, and resolution sees one import
 * at a time. In an __init__.py, module-level from-imports are re-exports.
 */
function fromStatement(
  n: Node,
  typeOnly: boolean,
  reexporting: boolean,
  out: Collected,
): void {
  const module = n.childForFieldName("module_name");
  if (!module) return;
  const specifier = moduleSpecifier(module);
  const kind = reexporting ? "reexport" : "static";
  const line = lineOf(n);
  if (n.namedChildren.some((c) => c.type === "wildcard_import")) {
    out.imports.push({
      kind,
      specifier,
      typeOnly,
      names: [{ imported: "*" }],
      line,
    });
    if (reexporting) out.exportAllFrom.push(specifier);
    return;
  }
  for (const name of n.childrenForFieldName("name")) {
    const target =
      name.type === "aliased_import" ? name.childForFieldName("name") : name;
    if (!target) continue;
    const imported = dotted(target);
    const alias =
      name.type === "aliased_import"
        ? name.childForFieldName("alias")?.text
        : undefined;
    out.imports.push({
      kind,
      specifier,
      typeOnly,
      names: [{ imported }],
      line,
    });
    if (reexporting) {
      out.reexports.push({
        name: alias ?? imported,
        from: { specifier, imported },
      });
    }
  }
}

function dynamicCall(call: Node, args: Node, out: Collected): void {
  if (!isDynamicImport(call)) return;
  const arg = nameArgument(args);
  const literal = arg ? plainString(arg) : undefined;
  const prefix = arg && literal === undefined ? literalPrefix(arg) : undefined;
  out.imports.push({
    kind: "dynamic",
    specifier: literal ?? null,
    ...(prefix !== undefined ? { dynamicPrefix: prefix } : {}),
    typeOnly: false,
    names: [],
    line: lineOf(call),
  });
}

/** Names an assignment target binds: `x`, `x, y`, `(x, y)`, `[x, y]`. */
function boundNames(n: Node): string[] {
  if (n.type === "identifier") return [n.text];
  if (["pattern_list", "tuple_pattern", "list_pattern"].includes(n.type)) {
    return n.namedChildren.flatMap(boundNames);
  }
  return [];
}

/** Statements that run at import time: module children and if/try/with bodies, not function or class bodies. */
function* moduleStatements(root: Node): Generator<Node> {
  for (const c of root.namedChildren) {
    yield c;
    if (
      [
        "if_statement",
        "try_statement",
        "with_statement",
        "elif_clause",
        "else_clause",
        "except_clause",
        "finally_clause",
        "block",
      ].includes(c.type)
    ) {
      yield* moduleStatements(c);
    }
  }
}

/** The literal strings of `__all__ = [...]` or `(...)`, if it is one. */
function allList(right: Node): string[] | undefined {
  if (right.type !== "list" && right.type !== "tuple") return undefined;
  const names = right.namedChildren.map(plainString);
  return names.every((s) => s !== undefined) ? names : undefined;
}

function localExports(root: Node): {
  locals: string[];
  all: string[] | undefined;
} {
  const locals: string[] = [];
  let all: string[] | undefined;
  for (const s of moduleStatements(root)) {
    let def = s;
    if (s.type === "decorated_definition")
      def = s.childForFieldName("definition") ?? s;
    if (def.type === "function_definition" || def.type === "class_definition") {
      const name = def.childForFieldName("name")?.text;
      if (name) locals.push(name);
      continue;
    }
    if (s.type !== "expression_statement") continue;
    for (const a of s.namedChildren) {
      if (a.type !== "assignment") continue;
      const left = a.childForFieldName("left");
      const right = a.childForFieldName("right");
      if (!left) continue;
      if (left.type === "identifier" && left.text === "__all__" && right) {
        all = allList(right);
        continue;
      }
      locals.push(...boundNames(left));
    }
  }
  return { locals, all };
}

/**
 * Exports: module-level definitions and assignments, plus an __init__.py's
 * re-exports. A literal `__all__` is the module's public interface; without
 * one, names starting with an underscore are private by convention.
 */
function exportsOf(root: Node, reexports: readonly ExportInfo[]): ExportInfo[] {
  const { locals, all } = localExports(root);
  const isPublic = (name: string) =>
    all === undefined ? !name.startsWith("_") : all.includes(name);
  const seen = new Set<string>();
  const out: ExportInfo[] = [];
  for (const e of [...locals.map((name) => ({ name })), ...reexports]) {
    if (!isPublic(e.name) || seen.has(e.name)) continue;
    seen.add(e.name);
    out.push(e);
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const GENERATED = /@generated\b|Code generated .* DO NOT EDIT/;

/** Non-blank lines; CRLF, CR and LF line endings all count the same. */
export function countLoc(text: string): number {
  let n = 0;
  for (const l of text.split(/\r\n|\r|\n/)) if (l.trim() !== "") n++;
  return n;
}

/**
 * Extract stage for Python: imports (static, TYPE_CHECKING-only, dynamic via
 * importlib), __init__.py re-exports and module exports, from the syntax
 * tree, plus flag usages and constant conditions. Pure: the same text,
 * grammar and extractor config always give the same facts. It never runs
 * Python (ADR-006).
 */
export function extract(
  file: ParsedFile<Tree>,
  cfg: ExtractorConfig,
): FileFacts {
  const root = file.tree.rootNode;
  const isInit = /(?:^|\/)__init__\.pyi?$/.test(file.path);
  const out: Collected = { imports: [], reexports: [], exportAllFrom: [] };
  for (const match of queryFor(file.tree.language).matches(root)) {
    const byName = new Map(match.captures.map((c) => [c.name, c.node]));
    const imp = byName.get("import");
    const from = byName.get("from");
    const future = byName.get("future");
    const call = byName.get("dynamic");
    const args = byName.get("args");
    if (imp) importStatement(imp, underTypeChecking(imp), out);
    else if (from) {
      fromStatement(
        from,
        underTypeChecking(from),
        isInit && atModuleLevel(from),
        out,
      );
    } else if (future) {
      out.imports.push({
        kind: "static",
        specifier: "__future__",
        typeOnly: false,
        names: future
          .childrenForFieldName("name")
          .map((n) => ({ imported: dotted(n) })),
        line: lineOf(future),
      });
    } else if (call && args) dynamicCall(call, args, out);
  }
  const { flagUsages, constantConditions } = findingsFacts(
    root,
    out.imports.flatMap((i) => (i.specifier === null ? [] : [i.specifier])),
    cfg,
  );
  return {
    imports: out.imports,
    exports: exportsOf(root, out.reexports),
    exportAllFrom: [...new Set(out.exportAllFrom)],
    flagUsages,
    constantConditions,
    isGenerated: GENERATED.test(file.text.slice(0, 2048)),
    loc: countLoc(file.text),
  };
}
