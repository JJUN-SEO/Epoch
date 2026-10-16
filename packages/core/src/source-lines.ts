/*
 * What counts as a line of source code when checking that something stored
 * holds none (CLAUDE.md "Local cache": no source stored): whitespace-
 * normalized lines of 10 or more characters. Shorter lines (`}`, `return;`)
 * are too common to mean anything. The cache's no-source test and the
 * summary sanitizer use the same rule.
 */

export const MIN_SOURCE_LINE_CHARS = 10;

/** Whitespace runs collapsed to one space, ends trimmed. */
export const normalizeLine = (line: string): string =>
  line.replace(/\s+/g, " ").trim();

/** The distinct normalized lines of `text` long enough to count as source. */
export function sourceLines(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = normalizeLine(raw);
    if (line.length >= MIN_SOURCE_LINE_CHARS) out.add(line);
  }
  return out;
}
