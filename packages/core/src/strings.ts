/*
 * Key-like string literals (CLAUDE.md FileFacts.strings, ADR-014): event
 * names, routes, topics and config keys that two files can share without
 * importing each other. Shared-string hints (M6) link files by the rare ones.
 * Pure and language-agnostic: each adapter hands over its literal values.
 */

/** At most this many strings are kept per file. */
export const MAX_FILE_STRINGS = 64;

const MIN_LENGTH = 3;
const MAX_LENGTH = 100;
/** Identifier, path and key characters; no whitespace, quotes or format syntax. */
const KEY_CHARS = /^[A-Za-z0-9_.:/@#{}-]+$/;
const SEPARATOR = /[._:/-]/;
const CAMEL_CASE = /[a-z][A-Z]/;
const URL_WITH_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const FILE_EXTENSION = /^\.[A-Za-z0-9]{1,8}$/;
const MIME_TYPE =
  /^(?:application|audio|font|image|message|model|multipart|text|video)\/[\w.-]+$/;

/** True for a literal that reads like a key, an event name or a route, not prose or a path. */
export function isKeyLikeLiteral(s: string): boolean {
  if (s.length < MIN_LENGTH || s.length > MAX_LENGTH) return false;
  if (!KEY_CHARS.test(s) || !/[A-Za-z]/.test(s)) return false;
  if (!SEPARATOR.test(s) && !CAMEL_CASE.test(s)) return false;
  if (s.startsWith("./") || s.startsWith("../")) return false;
  return !(
    URL_WITH_SCHEME.test(s) ||
    FILE_EXTENSION.test(s) ||
    MIME_TYPE.test(s)
  );
}

/**
 * A file's key-like strings: distinct values in source order, minus
 * `exclude` (its import specifiers), the first MAX_FILE_STRINGS of them,
 * sorted so the facts do not depend on how many were dropped after them.
 */
export function keyLikeStrings(
  values: Iterable<string>,
  exclude: ReadonlySet<string>,
): string[] {
  const kept = new Set<string>();
  for (const v of values) {
    if (kept.size >= MAX_FILE_STRINGS) break;
    if (!kept.has(v) && !exclude.has(v) && isKeyLikeLiteral(v)) kept.add(v);
  }
  return [...kept].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
