import { OLLAMA_ORIGIN, SUMMARY_ORIGINS } from "@epoch-dev/scorers/origins";

/*
 * The egress session's own filter (ADR-016), a second layer behind the
 * network wrapper's allowlist: the model origins and nothing else, and
 * offline only the model on this machine. By origin, so a lookalike host,
 * another port or scheme never passes.
 */

export function egressAllows(url: string, offline: boolean): boolean {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  if (origin === OLLAMA_ORIGIN) return true;
  return (
    !offline && (Object.values(SUMMARY_ORIGINS) as string[]).includes(origin)
  );
}
