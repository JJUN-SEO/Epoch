/*
 * Coverage ingestion (PLAN.md M4, ADR-020): lcov, Cobertura XML, Istanbul
 * JSON, Clover XML and Go cover profiles, mapped to repo-relative paths.
 * Pure: text in, line counts out. The XML is read by a small linear scanner
 * written here (no regex from any repo file, no backtracking), enough for the
 * elements these reports use.
 */

export interface FileCoverage {
  /** Instrumented lines (statements, for Go profiles). */
  readonly lines: number;
  /** Instrumented lines hit at least once. */
  readonly covered: number;
}

export type CoverageFormat =
  "lcov" | "cobertura" | "istanbul-json" | "clover" | "go";

/** Reports larger than this are not read. */
export const MAX_COVERAGE_BYTES = 64 * 1024 * 1024;

/**
 * Where coverage reports are looked for, relative to the repository root and
 * to every project folder (package.json, pyproject.toml, go.mod...). Each
 * group is one tool's output from one run, so only the first report found in
 * a group is read.
 */
export const COVERAGE_GROUPS: readonly (readonly string[])[] = [
  // Jest, vitest, c8 and nyc write into coverage/; Jest's and vitest's
  // default reporters include json (coverage-final.json) and clover.
  [
    "coverage/lcov.info",
    "coverage/coverage-final.json",
    "coverage/clover.xml",
    "coverage/cobertura-coverage.xml",
  ],
  // coverage.py: `coverage xml` and `coverage lcov`.
  ["coverage.xml", "coverage.lcov"],
  // go test -coverprofile: cover.out in `go help testflag`, coverage.out by habit.
  ["cover.out", "coverage.out"],
  // A plain lcov tracefile.
  ["lcov.info"],
];

const GO_MODES = new Set(["set", "count", "atomic"]);

export function detectFormat(text: string): CoverageFormat | undefined {
  const head = text.slice(0, 4096).trimStart();
  if (head.startsWith("<")) {
    if (!/<coverage[\s>]/.test(head)) return undefined;
    // Clover puts a <project> under <coverage>; Cobertura has none.
    return /<project[\s>/]/.test(head) ? "clover" : "cobertura";
  }
  if (head.startsWith("{"))
    return head.includes('"statementMap"') ? "istanbul-json" : undefined;
  if (head.startsWith("mode:")) {
    const nl = head.indexOf("\n");
    const mode = head.slice(5, nl === -1 ? undefined : nl).trim();
    return GO_MODES.has(mode) ? "go" : undefined;
  }
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

/**
 * Clover XML (Istanbul's and PHPUnit's reporters): per <file>, its
 * statement and condition <line num count> elements. Method lines mark a
 * declaration, not an executable line, and are skipped. The path is the
 * `path` attribute (Istanbul) or else `name` (PHPUnit writes the full path
 * there).
 */
export function parseClover(text: string): Map<string, FileCoverage> {
  const set = new LineSet();
  let file: string | undefined;
  for (const { tag } of xmlTags(text)) {
    if (tag.name === "file") {
      const path = tag.attrs.get("path") ?? tag.attrs.get("name");
      file = tag.closing || path === undefined ? undefined : slashes(path);
    } else if (tag.name === "line" && !tag.closing && file !== undefined) {
      const type = tag.attrs.get("type");
      if (type !== "stmt" && type !== "cond") continue;
      const number = Number(tag.attrs.get("num"));
      if (Number.isInteger(number) && number > 0) {
        set.line(file, number, Number(tag.attrs.get("count") ?? "0") > 0);
      }
    }
  }
  return set.result();
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Istanbul JSON (coverage-final.json, from vitest, jest, nyc and c8): a
 * statement counts on its start line, and a line is hit if any statement
 * starting there is, as istanbul-lib-coverage's getLineCoverage does.
 */
export function parseIstanbulJson(text: string): Map<string, FileCoverage> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return new Map();
  }
  const set = new LineSet();
  if (!isRecord(data)) return set.result();
  for (const [key, entry] of Object.entries(data)) {
    if (!isRecord(entry)) continue;
    const { statementMap, s } = entry;
    if (!isRecord(statementMap) || !isRecord(s)) continue;
    const file = slashes(typeof entry.path === "string" ? entry.path : key);
    for (const [id, count] of Object.entries(s)) {
      const statement = statementMap[id];
      const start = isRecord(statement) ? statement.start : undefined;
      const line = isRecord(start) ? start.line : undefined;
      if (typeof line !== "number" || !Number.isInteger(line) || line < 1)
        continue;
      set.line(file, line, typeof count === "number" && count > 0);
    }
  }
  return set.result();
}

const isBlockRange = (range: string): boolean => {
  const parts = range.split(/[.,]/);
  return parts.length === 4 && parts.every((p) => /^\d+$/.test(p));
};

/**
 * Go cover profile (`go test -coverprofile`): `mode:` then one block per
 * line, `import/path/file.go:startLine.col,endLine.col statements count`.
 * The unit is the statement, as in go test's percentages. A block repeated
 * by several test binaries counts once, hit if any run hit it.
 */
export function parseGoProfile(text: string): Map<string, FileCoverage> {
  const blocks = new Map<
    string,
    Map<string, { stmts: number; hit: boolean }>
  >();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("mode:")) continue;
    const colon = line.lastIndexOf(":");
    if (colon <= 0) continue;
    const [range, stmts, count, extra] = line.slice(colon + 1).split(" ");
    const n = Number(stmts);
    if (
      range === undefined ||
      extra !== undefined ||
      !isBlockRange(range) ||
      !Number.isInteger(n) ||
      n < 0 ||
      !/^\d+$/.test(count ?? "")
    )
      continue;
    const file = slashes(line.slice(0, colon));
    let fileBlocks = blocks.get(file);
    if (!fileBlocks) {
      fileBlocks = new Map();
      blocks.set(file, fileBlocks);
    }
    const prev = fileBlocks.get(range);
    fileBlocks.set(range, {
      stmts: n,
      hit: (prev?.hit ?? false) || Number(count) > 0,
    });
  }
  const out = new Map<string, FileCoverage>();
  for (const [file, fileBlocks] of blocks) {
    let lines = 0;
    let covered = 0;
    for (const b of fileBlocks.values()) {
      lines += b.stmts;
      if (b.hit) covered += b.stmts;
    }
    if (lines > 0) out.set(file, { lines, covered });
  }
  return out;
}

/** A Go module: its path from go.mod and its repo-relative folder. */
export interface GoModule {
  readonly path: string;
  /** "" for the repository root. */
  readonly dir: string;
}

/**
 * Rewrites a Go profile's import paths to repo-relative ones through the
 * module that owns each (the longest module path that prefixes it). Paths in
 * no known module (dependencies under -coverpkg) are dropped and counted.
 * With no modules known, the paths are left for mapCoverage's suffix rules.
 */
export function rebaseGoPaths(
  report: ReadonlyMap<string, FileCoverage>,
  modules: readonly GoModule[],
): { readonly files: Map<string, FileCoverage>; readonly outside: number } {
  if (modules.length === 0) return { files: new Map(report), outside: 0 };
  const byLength = [...modules].sort((a, b) => b.path.length - a.path.length);
  const files = new Map<string, FileCoverage>();
  let outside = 0;
  for (const [importPath, coverage] of report) {
    const owner = byLength.find((m) => importPath.startsWith(`${m.path}/`));
    if (owner === undefined) {
      outside++;
      continue;
    }
    const rest = importPath.slice(owner.path.length + 1);
    files.set(owner.dir === "" ? rest : `${owner.dir}/${rest}`, coverage);
  }
  return { files, outside };
}

const isRooted = (p: string): boolean =>
  p.startsWith("/") || /^[A-Za-z]:\//.test(p);

/**
 * A report found in a project folder: its relative paths (and Cobertura
 * sources) are read from that folder, where the tool ran. Absolute paths
 * are kept.
 */
export function inFolder(
  report: ReadonlyMap<string, FileCoverage>,
  sources: readonly string[],
  folder: string,
): { report: Map<string, FileCoverage>; sources: string[] } {
  const from = (p: string) =>
    folder === "" || isRooted(p) ? p : `${folder}/${p}`;
  return {
    report: new Map([...report].map(([p, c]) => [from(p), c])),
    sources: sources.map(from),
  };
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
      if (!isRooted(path)) {
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
