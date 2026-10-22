/*
 * Fuzzy matching for the command palette: the query's characters must appear
 * in order. Matches at the start of a path segment or word, runs of
 * consecutive characters, and matches inside the file name score higher.
 */

const SEPARATORS = "/\\_-. ";

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const before = text[i - 1] ?? "";
  const here = text[i] ?? "";
  if (SEPARATORS.includes(before)) return true;
  return (
    here !== here.toLowerCase() &&
    before === before.toLowerCase() &&
    before !== before.toUpperCase()
  );
}

/** Greedy left-to-right match of `q` in `text` from `start`; undefined if it does not match. */
function greedy(q: string, text: string, start: number): number | undefined {
  const lower = text.toLowerCase();
  let score = 0;
  let qi = 0;
  let prev = -2;
  for (let i = start; i < text.length && qi < q.length; i++) {
    if (lower[i] !== q[qi]) continue;
    let s = 1;
    if (i === prev + 1) s += 4;
    if (isWordStart(text, i)) s += 3;
    score += s;
    prev = i;
    qi++;
  }
  return qi === q.length ? score : undefined;
}

/** Higher is better; undefined when `candidate` does not contain the query's characters in order. */
export function fuzzyScore(
  query: string,
  candidate: string,
): number | undefined {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (q === "") return 0;
  const base = candidate.lastIndexOf("/") + 1;
  const whole = greedy(q, candidate, 0);
  if (whole === undefined) return undefined;
  const inName = base > 0 ? greedy(q, candidate, base) : undefined;
  const best = Math.max(
    whole,
    inName === undefined ? 0 : inName + q.length * 2,
  );
  // Shorter candidates win ties.
  return best - candidate.length / 1000;
}

/** Items matching `query`, best first (ties by key), at most `limit`. */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  key: (item: T) => string,
  limit: number,
): T[] {
  const scored: { item: T; key: string; score: number }[] = [];
  for (const item of items) {
    const k = key(item);
    const score = fuzzyScore(query, k);
    if (score !== undefined) scored.push({ item, key: k, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return scored.slice(0, limit).map((s) => s.item);
}
