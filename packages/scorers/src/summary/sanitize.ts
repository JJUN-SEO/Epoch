import { normalizeLine } from "@epoch-dev/core";

/*
 * What is kept of a model's answer before it is stored (CLAUDE.md: the
 * cache never stores code). Code blocks are dropped, and so is any sentence
 * that repeats a line of the source sent (core sourceLines: the same rule
 * as the cache's no-source test). Markdown becomes plain text, and the
 * result is cut to a length.
 */

export function sanitizeSummary(
  raw: string,
  opts: {
    /** Normalized source lines (core sourceLines) that must not appear. */
    readonly forbidden: ReadonlySet<string>;
    readonly maxChars: number;
  },
): string {
  const prose = raw
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/^\s*(?:#{1,6}|[-*•]|\d+[.)])\s+/gm, "");
  const forbidden = [...opts.forbidden];
  const sentences = normalizeLine(prose)
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s !== "" && !forbidden.some((line) => s.includes(line)));
  let text = sentences.join(" ");
  if (text.length <= opts.maxChars) return text;
  let out = "";
  for (const s of sentences) {
    const next = out === "" ? s : `${out} ${s}`;
    if (next.length > opts.maxChars) break;
    out = next;
  }
  if (out !== "") return out;
  text = text.slice(0, opts.maxChars - 1);
  const space = text.lastIndexOf(" ");
  return `${(space > 0 ? text.slice(0, space) : text).trimEnd()}…`;
}
