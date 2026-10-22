import { Query, type Language, type Node, type Tree } from "web-tree-sitter";
import {
  keyLikeStrings,
  type ExportInfo,
  type ExtractorConfig,
  type FileFacts,
  type ImportedName,
  type ParsedFile,
  type RawImport,
} from "@epoch-dev/core";
import { findingsFacts } from "./findings-facts.js";
import { IMPORTS_QUERY, STRINGS_QUERY } from "./queries.generated.js";

const queries = new WeakMap<Language, Query>();
const stringQueries = new WeakMap<Language, Query>();

function queryFor(language: Language): Query {
  let q = queries.get(language);
  if (!q) {
    q = new Query(language, IMPORTS_QUERY);
    queries.set(language, q);
  }
  return q;
}

/** Every string literal's value, in source order (FileFacts.strings, ADR-014). */
function literalValues(root: Node): string[] {
  let q = stringQueries.get(root.tree.language);
  if (!q) {
    q = new Query(root.tree.language, STRINGS_QUERY);
    stringQueries.set(root.tree.language, q);
  }
  return q.captures(root).flatMap((c) => stringValue(c.node) ?? []);
}

const lineOf = (n: Node): number => n.startPosition.row + 1;

/** True if `n` has an anonymous child token such as "type", "default" or "=". */
const hasToken = (n: Node, token: string): boolean =>
  n.children.some((c) => !c.isNamed && c.type === token);

const child = (n: Node, type: string): Node | undefined =>
  n.namedChildren.find((c) => c.type === type);

/** The value of a string literal (quotes removed), or undefined if `n` is not one. */
function stringValue(n: Node | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === "string") return n.text.slice(1, -1);
  if (n.type === "template_string" && !child(n, "template_substitution")) {
    return n.text.slice(1, -1);
  }
  return undefined;
}

/** Name text of an import/export specifier part (identifier or string). */
const nameText = (n: Node | null): string | undefined =>
  n ? (stringValue(n) ?? n.text) : undefined;

/** Literal prefix of a non-literal specifier: `./pages/${x}` or "./pages/" + x. */
function literalPrefix(n: Node): string | undefined {
  if (n.type === "template_string") {
    const end = n.text.indexOf("${");
    return end > 1 ? n.text.slice(1, end) : undefined;
  }
  if (n.type === "binary_expression" && hasToken(n, "+")) {
    const left = n.childForFieldName("left");
    if (!left) return undefined;
    return stringValue(left) ?? literalPrefix(left);
  }
  return undefined;
}

interface Pending extends RawImport {
  readonly column: number;
}

function splitByType(
  base: Omit<RawImport, "typeOnly" | "names">,
  column: number,
  values: ImportedName[],
  types: ImportedName[],
  statementTypeOnly: boolean,
  keepEmptyValue: boolean,
): Pending[] {
  if (statementTypeOnly) {
    return [{ ...base, typeOnly: true, names: [...values, ...types], column }];
  }
  const out: Pending[] = [];
  if (values.length > 0 || (types.length === 0 && keepEmptyValue)) {
    out.push({ ...base, typeOnly: false, names: values, column });
  }
  if (types.length > 0)
    out.push({ ...base, typeOnly: true, names: types, column });
  return out;
}

function importStatement(n: Node): Pending[] {
  const line = lineOf(n);
  const column = n.startPosition.column;
  const req = child(n, "import_require_clause");
  if (req) {
    // import x = require("x"): the whole module, never traced through barrels.
    return [
      {
        kind: "require",
        specifier: stringValue(req.childForFieldName("source")) ?? null,
        typeOnly: hasToken(n, "type"),
        names: [],
        line,
        column,
      },
    ];
  }
  const specifier = stringValue(n.childForFieldName("source"));
  if (specifier === undefined) return [];
  const clause = child(n, "import_clause");
  if (!clause) {
    return [
      {
        kind: "side-effect",
        specifier,
        typeOnly: false,
        names: [],
        line,
        column,
      },
    ];
  }
  const values: ImportedName[] = [];
  const types: ImportedName[] = [];
  for (const c of clause.namedChildren) {
    if (c.type === "identifier") values.push({ imported: "default" });
    else if (c.type === "namespace_import") values.push({ imported: "*" });
    else if (c.type === "named_imports") {
      for (const spec of c.namedChildren) {
        if (spec.type !== "import_specifier") continue;
        const imported = nameText(spec.childForFieldName("name"));
        if (imported === undefined) continue;
        (hasToken(spec, "type") ? types : values).push({ imported });
      }
    }
  }
  return splitByType(
    { kind: "static", specifier, line },
    column,
    values,
    types,
    hasToken(n, "type"),
    true,
  );
}

/** Names bound by a destructuring or plain binding pattern. */
function patternNames(n: Node): string[] {
  switch (n.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      return [n.text];
    case "pair_pattern": {
      const value = n.childForFieldName("value");
      return value ? patternNames(value) : [];
    }
    case "assignment_pattern": {
      const left = n.childForFieldName("left");
      return left ? patternNames(left) : [];
    }
    case "object_pattern":
    case "array_pattern":
    case "rest_pattern":
      return n.namedChildren.flatMap(patternNames);
    default:
      return [];
  }
}

/** Names declared by an exported declaration. */
function declaredNames(decl: Node): string[] {
  if (
    decl.type === "lexical_declaration" ||
    decl.type === "variable_declaration"
  ) {
    return decl.namedChildren
      .filter((c) => c.type === "variable_declarator")
      .flatMap((d) => {
        const name = d.childForFieldName("name");
        return name ? patternNames(name) : [];
      });
  }
  if (decl.type === "ambient_declaration") {
    return decl.namedChildren.flatMap(declaredNames);
  }
  const name = decl.childForFieldName("name");
  return name ? [nameText(name) ?? name.text] : [];
}

function exportStatement(
  n: Node,
  topLevel: boolean,
  exports: ExportInfo[],
  exportAllFrom: string[],
): Pending[] {
  const line = lineOf(n);
  const column = n.startPosition.column;
  // The grammar has no rule for `export type * from` (TS 5.0) and wraps the
  // `type` keyword in an ERROR node; the rest of the statement parses normally.
  const typeOnly =
    hasToken(n, "type") ||
    n.children.some((c) => c.type === "ERROR" && c.text === "type");
  const specifier = stringValue(n.childForFieldName("source"));

  if (specifier !== undefined) {
    const clause = child(n, "export_clause");
    const ns = child(n, "namespace_export");
    const base = { kind: "reexport" as const, specifier, line };
    if (clause) {
      const values: ImportedName[] = [];
      const types: ImportedName[] = [];
      for (const spec of clause.namedChildren) {
        if (spec.type !== "export_specifier") continue;
        const imported = nameText(spec.childForFieldName("name"));
        if (imported === undefined) continue;
        const alias = nameText(spec.childForFieldName("alias"));
        if (topLevel)
          exports.push({
            name: alias ?? imported,
            from: { specifier, imported },
          });
        const entry: ImportedName =
          alias === undefined ? { imported } : { imported, exportedAs: alias };
        (hasToken(spec, "type") ? types : values).push(entry);
      }
      return splitByType(base, column, values, types, typeOnly, true);
    }
    if (ns) {
      const name = ns.namedChildren[0]
        ? nameText(ns.namedChildren[0])
        : undefined;
      if (name === undefined) return [];
      if (topLevel) exports.push({ name, from: { specifier, imported: "*" } });
      return [
        {
          ...base,
          typeOnly,
          names: [{ imported: "*", exportedAs: name }],
          column,
        },
      ];
    }
    if (topLevel) exportAllFrom.push(specifier);
    return [{ ...base, typeOnly, names: [{ imported: "*" }], column }];
  }

  if (!topLevel) return [];
  if (hasToken(n, "default")) {
    exports.push({ name: "default" });
  } else if (hasToken(n, "=")) {
    exports.push({ name: "export=" }); // export = x
  } else {
    const decl = n.childForFieldName("declaration");
    if (decl) {
      for (const name of declaredNames(decl)) exports.push({ name });
    } else {
      const clause = child(n, "export_clause");
      for (const spec of clause?.namedChildren ?? []) {
        if (spec.type !== "export_specifier") continue;
        const name =
          nameText(spec.childForFieldName("alias")) ??
          nameText(spec.childForFieldName("name"));
        if (name !== undefined) exports.push({ name });
      }
    }
  }
  return [];
}

/** import(...) or require(...): a literal specifier, or null plus any literal prefix. */
function callImport(
  kind: "dynamic" | "require",
  call: Node,
  args: Node,
): Pending {
  const arg = args.namedChildren[0];
  const literal = stringValue(arg);
  const base = {
    kind,
    typeOnly: false,
    names: [],
    line: lineOf(call),
    column: call.startPosition.column,
  };
  if (literal !== undefined) return { ...base, specifier: literal };
  const prefix = arg ? literalPrefix(arg) : undefined;
  return prefix
    ? { ...base, specifier: null, dynamicPrefix: prefix }
    : { ...base, specifier: null };
}

/**
 * import.meta.resolve(...), require.resolve(...) or new URL(..., import.meta.url)
 * with a computed path: the file it names is loaded at run time, so its literal
 * prefix marks the files under it as possibly loaded, as import(`./x/${n}`)
 * does. A literal path is not recorded: it may name an asset, not a module.
 */
function runtimePath(call: Node, args: Node): Pending | undefined {
  const arg = args.namedChildren[0];
  if (!arg || stringValue(arg) !== undefined) return undefined;
  const prefix = literalPrefix(arg);
  if (prefix === undefined) return undefined;
  return {
    kind: "dynamic",
    specifier: null,
    dynamicPrefix: prefix,
    typeOnly: false,
    names: [],
    line: lineOf(call),
    column: call.startPosition.column,
  };
}

const RESOLVERS = new Set(["import.meta", "require"]);

const GENERATED = /@generated\b|Code generated .* DO NOT EDIT/;

const REFERENCE =
  /^\/\/\/\s*<reference\s+(path|types)\s*=\s*(["'])([^"']+)\2\s*\/>/;
const isRelativePath = (p: string) =>
  p.startsWith("./") || p.startsWith("../") || p.startsWith("/");

/**
 * Triple-slash references to files, as type-only dependencies. TypeScript
 * reads them only in the leading comments. `path` is relative to the file
 * even without "./"; `types` names a file only when it is a relative path (a
 * package name, like "node", is a type package, not a file).
 */
function referencePaths(root: Node): Pending[] {
  const out: Pending[] = [];
  for (const c of root.children) {
    if (c.type !== "comment" && c.type !== "hash_bang_line") break;
    const m = REFERENCE.exec(c.text);
    const raw = m?.[3];
    if (raw === undefined) continue;
    if (m?.[1] === "types" && !isRelativePath(raw)) continue;
    out.push({
      kind: "static",
      specifier: isRelativePath(raw) ? raw : `./${raw}`,
      typeOnly: true,
      names: [],
      line: lineOf(c),
      column: c.startPosition.column,
    });
  }
  return out;
}

/** Non-blank lines; CRLF, CR and LF line endings all count the same. */
export function countLoc(text: string): number {
  let n = 0;
  for (const l of text.split(/\r\n|\r|\n/)) if (l.trim() !== "") n++;
  return n;
}

/**
 * Extract stage for TS/JS: imports, re-exports and exports, flag usages and
 * constant conditions, from the syntax tree. Pure: the same text, grammar and
 * extractor config always give the same facts.
 */
export function extract(
  file: ParsedFile<Tree>,
  cfg: ExtractorConfig,
): FileFacts {
  const root = file.tree.rootNode;
  const pending: Pending[] = referencePaths(root);
  const exports: ExportInfo[] = [];
  const exportAllFrom: string[] = [];

  for (const match of queryFor(file.tree.language).matches(root)) {
    const byName = new Map(match.captures.map((c) => [c.name, c.node]));
    const imp = byName.get("import");
    const exp = byName.get("export");
    const args = byName.get("args");
    if (imp) pending.push(...importStatement(imp));
    else if (exp) {
      const topLevel = exp.parent?.type === "program";
      pending.push(...exportStatement(exp, topLevel, exports, exportAllFrom));
    } else if (args) {
      const dyn = byName.get("dynamic");
      const req = byName.get("require");
      const resolveCall = byName.get("resolve");
      const url = byName.get("url");
      if (dyn) pending.push(callImport("dynamic", dyn, args));
      else if (req) pending.push(callImport("require", req, args));
      else if (resolveCall) {
        const object = byName.get("resolver")?.childForFieldName("object");
        const found =
          object && RESOLVERS.has(object.text)
            ? runtimePath(resolveCall, args)
            : undefined;
        if (found) pending.push(found);
      } else if (url && args.namedChildren[1]?.text === "import.meta.url") {
        const found = runtimePath(url, args);
        if (found) pending.push(found);
      }
    }
  }

  pending.sort((a, b) => a.line - b.line || a.column - b.column);
  const imports: RawImport[] = pending.map(
    ({ column: _column, ...raw }) => raw,
  );

  const seen = new Set<string>();
  const uniqueExports = exports.filter((e) => {
    const key = `${e.name}\u0000${e.from?.specifier ?? ""}\u0000${e.from?.imported ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const specifiers = imports.flatMap((i) =>
    i.specifier === null ? [] : [i.specifier],
  );
  const { flagUsages, constantConditions } = findingsFacts(
    root,
    specifiers,
    cfg,
  );
  return {
    imports,
    exports: uniqueExports,
    exportAllFrom: [...new Set(exportAllFrom)],
    flagUsages,
    constantConditions,
    strings: keyLikeStrings(
      literalValues(root),
      new Set([...specifiers, ...exportAllFrom]),
    ),
    isGenerated: GENERATED.test(file.text.slice(0, 2048)),
    loc: countLoc(file.text),
  };
}
