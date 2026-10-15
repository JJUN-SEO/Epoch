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

/** Non-blank lines, CRLF-safe. */
export function countLoc(text: string): number {
  let n = 0;
  for (const l of text.split(/\r\n|\r|\n/)) if (l.trim() !== "") n++;
  return n;
}

/**
 * A Go string literal's value: raw strings as written (carriage returns
 * dropped, as the spec says), interpreted strings with their escapes
 * decoded. Null when an escape cannot be decoded.
 */
function stringValue(node: Node): string | null {
  const body = node.text.slice(1, -1);
  if (node.type === "raw_string_literal") return body.replace(/\r/g, "");
  if (node.type !== "interpreted_string_literal") return null;
  if (!body.includes("\\")) return body;
  try {
    const value: unknown = JSON.parse(`"${body}"`);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function importOf(spec: Node): RawImport | undefined {
  const path = spec.childForFieldName("path");
  if (!path) return undefined;
  const blank = spec.childForFieldName("name")?.type === "blank_identifier";
  return {
    kind: blank ? "side-effect" : "static",
    specifier: stringValue(path),
    typeOnly: false,
    // A Go import brings in a whole package; the names used are not tracked.
    names: blank ? [] : [{ imported: "*" }],
    line: spec.startPosition.row + 1,
  };
}

/** The spec's rule for exported identifiers: an upper-case first letter (Lu). */
const isExported = (name: string): boolean => /^\p{Lu}/u.test(name);

/** Names declared at package level: functions, types, constants, variables. */
function declaredNames(root: Node): string[] {
  const names: string[] = [];
  const add = (n: Node | null) => {
    if (n) names.push(n.text);
  };
  for (const decl of root.namedChildren) {
    switch (decl.type) {
      case "function_declaration":
        add(decl.childForFieldName("name"));
        break;
      case "type_declaration":
        for (const spec of decl.namedChildren) {
          if (spec.type === "type_spec" || spec.type === "type_alias") {
            add(spec.childForFieldName("name"));
          }
        }
        break;
      case "const_declaration":
      case "var_declaration":
        for (const child of decl.namedChildren) {
          const specs =
            child.type === "var_spec_list" ? child.namedChildren : [child];
          for (const spec of specs) {
            if (spec.type !== "const_spec" && spec.type !== "var_spec")
              continue;
            for (const n of spec.childrenForFieldName("name")) add(n);
          }
        }
        break;
      default:
        break;
    }
  }
  return names;
}

const GENERATED = /^\/\/ Code generated .* DO NOT EDIT\.$/;

/**
 * `go help generate`: a line matching ^// Code generated .* DO NOT EDIT\.$
 * before the first non-comment, non-blank text marks a generated file.
 */
function isGenerated(root: Node): boolean {
  for (const child of root.children) {
    if (child.type !== "comment") return false;
    if (GENERATED.test(child.text.replace(/\r$/, ""))) return true;
  }
  return false;
}

/**
 * Extract stage for Go: package imports, package-level exported names and
 * the generated-file marker, flag usages and constant conditions, from the
 * syntax tree. Pure: the same text, grammar and extractor config always give
 * the same facts. It never runs the go command (ADR-006).
 */
export function extract(
  file: ParsedFile<Tree>,
  cfg: ExtractorConfig,
): FileFacts {
  const root = file.tree.rootNode;
  const imports: RawImport[] = [];
  for (const match of queryFor(file.tree.language).matches(root)) {
    for (const c of match.captures) {
      const imp = importOf(c.node);
      if (imp) imports.push(imp);
    }
  }
  const exports: ExportInfo[] = [...new Set(declaredNames(root))]
    .filter(isExported)
    .map((name) => ({ name }));
  const { flagUsages, constantConditions } = findingsFacts(
    root,
    imports.flatMap((i) => (i.specifier === null ? [] : [i.specifier])),
    cfg,
  );
  return {
    imports,
    exports,
    exportAllFrom: [],
    flagUsages,
    constantConditions,
    isGenerated: isGenerated(root),
    loc: countLoc(file.text),
  };
}
