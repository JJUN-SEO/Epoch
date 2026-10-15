/*
 * Which lines of a working file are unchanged since HEAD, and where they sat
 * in HEAD (ADR-007): blame runs on HEAD's tree, so uncommitted lines must be
 * found here, in process, never by asking git to read the working tree
 * (where repo-configured filters could run). Myers' O((N+M)·D) algorithm,
 * with a cap on D: past it, every line counts as changed, which only ever
 * makes code look newer (so findings stay conservative).
 */

const MAX_EDITS = 2000;

/**
 * For each line of `after` (0-based), its 0-based line in `before` when
 * unchanged, or -1 when added or changed. Undefined when the diff is too
 * large to compute within the edit cap.
 */
export function unchangedLines(
  before: readonly string[],
  after: readonly string[],
): Int32Array | undefined {
  const map = new Int32Array(after.length).fill(-1);
  // Common prefix and suffix first: most edits are small.
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  ) {
    map[start] = start;
    start++;
  }
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
    map[endA] = endB;
  }
  const n = endB - start;
  const m = endA - start;
  if (n === 0 || m === 0) return map;

  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v[-d-1 .. d+1] as it was before round d: O(D²) memory.
  const trace: Int32Array[] = [];
  let found = false;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d ||
        (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))
          ? (v[offset + k + 1] ?? 0)
          : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && before[start + x] === after[start + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break outer;
      }
    }
  }
  if (!found) return undefined;
  // Walk the trace back, recording the diagonal (unchanged) moves.
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const slice = trace[d];
    if (slice === undefined) break;
    const at = (j: number) => slice[j + d + 1] ?? 0;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      map[start + y] = start + x;
    }
    if (d > 0) {
      x = prevX;
      y = prevY;
    }
  }
  return map;
}

/** Splits text into lines the way blame counts them (CRLF and LF). */
export const splitLines = (text: string): string[] => {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};
