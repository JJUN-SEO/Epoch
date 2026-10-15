/*
 * Coverage ingestion (PLAN.md M4): lcov and Cobertura XML reports, mapped to
 * repo-relative paths. Pure: text in, line counts out. The XML is read by a
 * small linear scanner written here (no regex from any repo file, no
 * backtracking), enough for the elements Cobertura reports use.
 */

export interface FileCoverage {
  /** Instrumented lines. */
  readonly lines: number;
  /** Instrumented lines hit at least once. */
  readonly covered: number;
}

export type CoverageFormat = "lcov" | "cobertura";

/** Reports larger than this are not read. */
export const MAX_COVERAGE_BYTES = 64 * 1024 * 1024;

/** Where a coverage report is looked for, inside the project. */
export const COVERAGE_CANDIDATES = [
  "coverage/lcov.info",
  "coverage/cobertura-coverage.xml",
  "coverage.xml",
  "lcov.info",
] as const;

export function detectFormat(text: string): CoverageFormat | undefined {
  const head = text.slice(0, 4096).trimStart();
  if (head.startsWith("<"))
    return /<coverage[\s>]/.test(head) ? "cobertura" : undefined;
  return /^(TN|SF):/m.test(head) ? "lcov" : undefined;
}

const slashes = (p: string): string =>
  p.replace(/\\/g, "/").replace(/^\.\//, "");

/** Per-file hit lines, merged across repeated records (any hit counts). */
class LineSet {
  private readonly hits = new Map<string, Map<number, boolean>>();
  private readonly totals = new Map<string, FileCoverage>();

  line(file: string, line: number, hit: boolean): void {
    let lines = this.hits.get(file);
    if (!lines) {
      lines = new Map();
      this.hits.set(file, lines);
    }
    lines.set(line, (lines.get(line) ?? false) || hit);
  }

  /** Summary counts for a file with no per-line data (lcov LF/LH only). */
  total(file: string, coverage: FileCoverage): void {
    if (!this.hits.has(file)) this.totals.set(file, coverage);
  }

  result(): Map<string, FileCoverage> {
    const out = new Map(this.totals);
    for (const [file, lines] of this.hits) {
      let covered = 0;
      for (const hit of lines.values()) if (hit) covered++;
      out.set(file, { lines: lines.size, covered });
    }
    return out;
  }
}

/** lcov tracefile: SF, DA, LF/LH, end_of_record (other records are ignored). */
export function parseLcov(text: string): Map<string, FileCoverage> {
  const set = new LineSet();
  let file: string | undefined;
  let lf: number | undefined;
  let lh: number | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      file = slashes(line.slice(3));
      lf = undefined;
      lh = undefined;
    } else if (line.startsWith("DA:") && file !== undefined) {
      const [n, hits] = line.slice(3).split(",");
      const number = Number(n);
      if (Number.isInteger(number) && number > 0) {
        set.line(file, number, Number(hits) > 0);
      }
    } else if (line.startsWith("LF:")) {
      lf = Number(line.slice(3));
    } else if (line.startsWith("LH:")) {
      lh = Number(line.slice(3));
    } else if (line === "end_of_record") {
      if (file !== undefined && lf !== undefined && lh !== undefined) {
        if (Number.isFinite(lf) && Number.isFinite(lh) && lf >= 0) {
          set.total(file, { lines: lf, covered: Math.min(lh, lf) });
        }
      }
      file = undefined;
    }
  }
  return set.result();
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(s: string): string {
  return s.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g,
    (whole, body: string) => {
      const code = body.startsWith("#x")
        ? parseInt(body.slice(2), 16)
        : body.startsWith("#")
          ? parseInt(body.slice(1), 10)
          : undefined;
      if (code === undefined) return ENTITIES[body] ?? whole;
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    },
  );
}

interface Tag {
  readonly name: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly closing: boolean;
  readonly selfClosing: boolean;
}

const isSpace = (c: string | undefined) =>
  c === " " || c === "\n" || c === "\t" || c === "\r";

/**
 * Walks the tags of an XML document in order, with the text before each
 * tag. Comments, processing instructions, doctypes and CDATA are skipped.
 * Linear in the input.
 */
function* xmlTags(text: string): Generator<{ tag: Tag; textBefore: string }> {
  let i = 0;
  let textStart = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) return;
    const textBefore = text.slice(textStart, lt);
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      i = textStart = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt);
      i = textStart = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text[lt + 1] === "?" || text[lt + 1] === "!") {
      const end = text.indexOf(">", lt);
      i = textStart = end === -1 ? text.length : end + 1;
      continue;
    }
    let j = lt + 1;
    const closing = text[j] === "/";
    if (closing) j++;
    const nameStart = j;
    while (
      j < text.length &&
      !isSpace(text[j]) &&
      text[j] !== ">" &&
      text[j] !== "/"
    )
      j++;
    const name = text.slice(nameStart, j);
    const attrs = new Map<string, string>();
    let selfClosing = false;
    while (j < text.length && text[j] !== ">") {
      if (isSpace(text[j])) {
        j++;
        continue;
      }
      if (text[j] === "/") {
        selfClosing = true;
        j++;
        continue;
      }
      const keyStart = j;
      while (
        j < text.length &&
        !isSpace(text[j]) &&
        text[j] !== "=" &&
        text[j] !== ">" &&
        text[j] !== "/"
      )
        j++;
      const key = text.slice(keyStart, j);
      while (isSpace(text[j])) j++;
      if (text[j] !== "=") continue;
      j++;
      while (isSpace(text[j])) j++;
      const quote = text[j];
      if (quote !== '"' && quote !== "'") continue;
      const end = text.indexOf(quote, j + 1);
      if (end === -1) return;
      attrs.set(key, decodeEntities(text.slice(j + 1, end)));
      j = end + 1;
    }
    if (j >= text.length) return;
    i = textStart = j + 1;
    yield { tag: { name, attrs, closing, selfClosing }, textBefore };
  }
}

/**
 * Cobertura XML: per <class filename>, the <line number hits> elements
 * directly under its <lines> (method-level lines repeat them and are
 * skipped). Filenames are joined with every <source> later, in mapping.
 */
export function parseCobertura(text: string): {
  readonly sources: string[];
  readonly files: Map<string, FileCoverage>;
} {
  const set = new LineSet();
  const sources: string[] = [];
  const stack: string[] = [];
  let file: string | undefined;
  for (const { tag, textBefore } of xmlTags(text)) {
    if (tag.closing) {
      if (tag.name === "source" && stack.at(-1) === "source") {
        const source = decodeEntities(textBefore).trim();
        if (source !== "") sources.push(slashes(source));
      }
      if (tag.name === "class") file = undefined;
      if (stack.at(-1) === tag.name) stack.pop();
      continue;
    }
    if (tag.name === "class") {
      const filename = tag.attrs.get("filename");
      file = filename === undefined ? undefined : slashes(filename);
    } else if (
      tag.name === "line" &&
      file !== undefined &&
      stack.at(-1) === "lines" &&
      stack.at(-2) === "class"
    ) {
      const number = Number(tag.attrs.get("number"));
      if (Number.isInteger(number) && number > 0) {
        set.line(file, number, Number(tag.attrs.get("hits") ?? "0") > 0);
      }
    }
    if (!tag.selfClosing) stack.push(tag.name);
  }
  return { sources, files: set.result() };
}

export interface MappedCoverage {
  /** Repo-relative path -> coverage. */
  readonly files: Map<string, FileCoverage>;
  /** Report paths matching no analyzed file (e.g. dependencies). */
  readonly unmatched: number;
  /** Report paths matching several analyzed files equally well. */
  readonly ambiguous: number;
}

/**
 * Maps report paths to repo-relative ones. A report path whose trailing
 * segments are an analyzed file's whole path maps to the longest such file
 * (CI absolute paths such as /home/runner/work/x/x/src/a.ts); a relative
 * report path (written from a package folder) maps to the one analyzed file
 * it ends. Anything else is unmatched or, if several files fit, ambiguous.
 */
export function mapCoverage(
  report: ReadonlyMap<string, FileCoverage>,
  repoFiles: readonly string[],
  sources: readonly string[] = [],
): MappedCoverage {
  const byBase = new Map<string, string[]>();
  for (const f of repoFiles) {
    const base = f.slice(f.lastIndexOf("/") + 1);
    const list = byBase.get(base);
    if (list) list.push(f);
    else byBase.set(base, [f]);
  }
  const files = new Map<string, FileCoverage>();
  let unmatched = 0;
  let ambiguous = 0;
  const add = (file: string, c: FileCoverage) => {
    const prev = files.get(file);
    files.set(
      file,
      prev
        ? { lines: prev.lines + c.lines, covered: prev.covered + c.covered }
        : c,
    );
  };
  for (const [raw, coverage] of report) {
    const candidates = [
      raw,
      ...sources.map((s) => `${s.replace(/\/+$/, "")}/${raw}`),
    ];
    let match: string | undefined;
    let tie = false;
    for (const path of candidates) {
      const base = path.slice(path.lastIndexOf("/") + 1);
      const options = byBase.get(base) ?? [];
      // The analyzed file whose whole path ends the report path.
      const whole = options
        .filter((f) => path === f || path.endsWith(`/${f}`))
        .sort((a, b) => b.length - a.length);
      if (whole[0] !== undefined) {
        match = whole[0];
        break;
      }
      // A relative report path ending one analyzed file.
      if (!path.startsWith("/") && !/^[A-Za-z]:\//.test(path)) {
        const ending = options.filter((f) => f.endsWith(`/${path}`));
        if (ending.length === 1) {
          match = ending[0];
          break;
        }
        if (ending.length > 1) tie = true;
      }
    }
    if (match !== undefined) add(match, coverage);
    else if (tie) ambiguous++;
    else unmatched++;
  }
  return { files, unmatched, ambiguous };
}
