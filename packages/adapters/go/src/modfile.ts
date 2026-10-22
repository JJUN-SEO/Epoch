/*
 * go.mod and go.work, read as data (ADR-013). The lexing follows the go
 * command's own (golang.org/x/mod/modfile, read.go): `//` comments to the end
 * of the line, "..." strings with backslash escapes, `...` raw strings,
 * parentheses for blocks, and identifiers made of any other printable runes.
 * Only the directives resolution needs are kept; versions are not compared.
 */

export interface Replace {
  /** The replaced module path. */
  readonly old: string;
  /** A directory (relative to the file, or rooted) or a module path. */
  readonly new: string;
}

export interface ModFile {
  /** The `module` path; undefined when absent (go.work files have none). */
  readonly module?: string;
  readonly requires: readonly string[];
  readonly replaces: readonly Replace[];
  /** go.work `use` directories, relative to the file. */
  readonly uses: readonly string[];
}

type Token =
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "(" | ")" | "\n" };

const PUNCTUATION = new Set(["(", ")", "[", "]", "{", "}", ","]);

function isIdentChar(c: string): boolean {
  return !PUNCTUATION.has(c) && !/\s/u.test(c) && /\P{C}/u.test(c);
}

/** A quoted string's value; malformed escapes keep the raw text. */
function unquote(raw: string): string {
  if (raw.startsWith("`")) return raw.slice(1, -1);
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "string" ? value : raw.slice(1, -1);
  } catch {
    return raw.slice(1, -1);
  }
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === " " || c === "\t" || c === "\r") {
      i++;
    } else if (text.startsWith("//", i)) {
      while (i < text.length && text.charAt(i) !== "\n") i++;
    } else if (c === "\n" || c === "(" || c === ")") {
      tokens.push({ kind: c });
      i++;
    } else if (c === '"' || c === "`") {
      let j = i + 1;
      while (
        j < text.length &&
        text.charAt(j) !== c &&
        text.charAt(j) !== "\n"
      ) {
        j += c === '"' && text.charAt(j) === "\\" ? 2 : 1;
      }
      tokens.push({ kind: "word", text: unquote(text.slice(i, j + 1)) });
      i = j + 1;
    } else if (isIdentChar(c)) {
      let j = i;
      while (
        j < text.length &&
        isIdentChar(text.charAt(j)) &&
        !text.startsWith("//", j)
      ) {
        j++;
      }
      tokens.push({ kind: "word", text: text.slice(i, j) });
      i = j;
    } else {
      i++; // other punctuation never appears in the directives read here
    }
  }
  return tokens;
}

/** Each directive line as [verb, ...args], with block lines prefixed by their verb. */
function lines(tokens: readonly Token[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let block: string | undefined;
  const flush = () => {
    if (current.length > 0) {
      out.push(block !== undefined ? [block, ...current] : current);
    }
    current = [];
  };
  for (const t of tokens) {
    if (t.kind === "word") {
      current.push(t.text);
    } else if (t.kind === "(") {
      // `verb (` opens a block; the verb applies to every line inside it.
      if (block === undefined && current.length === 1) block = current[0];
      current = [];
    } else if (t.kind === ")") {
      flush();
      block = undefined;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/** Parses a go.mod or go.work file; unknown directives are skipped. */
export function parseModFile(text: string): ModFile {
  let module: string | undefined;
  const requires: string[] = [];
  const replaces: Replace[] = [];
  const uses: string[] = [];
  for (const [verb, ...args] of lines(tokenize(text))) {
    if (verb === "module" && args[0] !== undefined) {
      module ??= args[0];
    } else if (verb === "require" && args[0] !== undefined) {
      requires.push(args[0]);
    } else if (verb === "use" && args[0] !== undefined) {
      uses.push(args[0]);
    } else if (verb === "replace") {
      const arrow = args.indexOf("=>");
      const old = args[0];
      const target = args[arrow + 1];
      if (arrow > 0 && old !== undefined && target !== undefined) {
        replaces.push({ old, new: target });
      }
    }
  }
  return {
    ...(module !== undefined ? { module } : {}),
    requires,
    replaces,
    uses,
  };
}

/**
 * Whether a replace target is a directory rather than a module path:
 * ".", "..", "./x", "../x" or a rooted path, in Unix or Windows syntax
 * (modfile's IsDirectoryPath).
 */
export function isDirectoryPath(p: string): boolean {
  return (
    p === "." ||
    p === ".." ||
    p.startsWith("./") ||
    p.startsWith(".\\") ||
    p.startsWith("../") ||
    p.startsWith("..\\") ||
    p.startsWith("/") ||
    p.startsWith("\\") ||
    /^[A-Za-z]:/.test(p)
  );
}
