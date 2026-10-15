/*
 * Glob patterns from epoch.config.json (CLAUDE.md: "Glob patterns use a glob
 * matcher, never regexes from repo files (ReDoS)"). Our own matcher, matched
 * by dynamic programming in O(pattern × path) time, so no pattern can make it
 * backtrack exponentially.
 *
 * Patterns are matched against repo-relative paths with forward slashes and
 * are anchored at the repository root:
 * - `*` matches any characters except `/`, `?` exactly one of them;
 * - a `**` segment matches zero or more whole segments (one or more at the
 *   end: `dir/**` matches what is inside `dir`, not `dir` itself);
 * - `{a,b}` matches either alternative (expanded up front, with a limit);
 * - a trailing `/` means everything under the directory (`legacy/` = `legacy/**`);
 * - anything else, `[` included, is literal.
 */

const MAX_PATTERN_LENGTH = 1024;
const MAX_ALTERNATIVES = 256;

/** Expands `{a,b}` groups (nested allowed) into plain patterns. */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open === -1) return [pattern];
  // Find the matching close brace and the top-level commas inside it.
  let depth = 0;
  const commas: number[] = [];
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (c === "," && depth === 1) commas.push(i);
  }
  if (close === -1 || commas.length === 0) {
    // An unclosed or comma-less brace is literal text.
    const rest = expandBraces(pattern.slice(open + 1));
    return rest.map((r) => `${pattern.slice(0, open + 1)}${r}`);
  }
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const bounds = [open, ...commas, close];
  const out: string[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const option = pattern.slice((bounds[i] ?? 0) + 1, bounds[i + 1]);
    for (const expanded of expandBraces(`${head}${option}${tail}`)) {
      out.push(expanded);
      if (out.length > MAX_ALTERNATIVES) {
        throw new Error(
          `glob pattern expands to more than ${String(MAX_ALTERNATIVES)} alternatives`,
        );
      }
    }
  }
  return out;
}

/** One segment against one path segment: `*` and `?` only, by DP. */
function segmentMatches(pattern: string, text: string): boolean {
  // prev[j]: pattern[0..i) matches text[0..j)
  let prev = new Array<boolean>(text.length + 1).fill(false);
  prev[0] = true;
  for (let i = 1; i <= pattern.length; i++) {
    const p = pattern.charAt(i - 1);
    const next = new Array<boolean>(text.length + 1).fill(false);
    if (p === "*") next[0] = prev[0] === true;
    for (let j = 1; j <= text.length; j++) {
      if (p === "*") next[j] = prev[j] === true || next[j - 1] === true;
      else if (p === "?" || p === text.charAt(j - 1)) {
        next[j] = prev[j - 1] === true;
      }
    }
    prev = next;
  }
  return prev[text.length] === true;
}

/** A brace-free pattern against a path, segment by segment, by DP. */
function plainMatches(pattern: string, path: string): boolean {
  const ps = pattern.split("/");
  const ts = path.split("/");
  // prev[j]: ps[0..i) matches ts[0..j)
  let prev = new Array<boolean>(ts.length + 1).fill(false);
  prev[0] = true;
  for (let i = 1; i <= ps.length; i++) {
    const seg = ps[i - 1] ?? "";
    // A trailing `**` needs at least one segment: `dir/**` is what is inside.
    const trailing = seg === "**" && i === ps.length;
    const next = new Array<boolean>(ts.length + 1).fill(false);
    if (seg === "**" && !trailing) next[0] = prev[0] === true;
    for (let j = 1; j <= ts.length; j++) {
      next[j] = trailing
        ? prev[j - 1] === true || next[j - 1] === true
        : seg === "**"
          ? prev[j] === true || next[j - 1] === true
          : prev[j - 1] === true && segmentMatches(seg, ts[j - 1] ?? "");
    }
    prev = next;
  }
  return prev[ts.length] === true;
}

function normalize(pattern: string): string {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(
      `glob pattern too long (over ${String(MAX_PATTERN_LENGTH)} characters)`,
    );
  }
  let p = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (p.endsWith("/")) p = `${p}**`;
  return p;
}

/** A matcher for any of `patterns`. Throws for an oversized pattern. */
export function globMatcher(
  patterns: readonly string[],
): (path: string) => boolean {
  const plain = patterns.flatMap((p) => expandBraces(normalize(p)));
  if (plain.length === 0) return () => false;
  return (path) => plain.some((p) => plainMatches(p, path));
}

export function matchesGlob(pattern: string, path: string): boolean {
  return globMatcher([pattern])(path);
}
