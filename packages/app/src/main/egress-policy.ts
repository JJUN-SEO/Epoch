import { OLLAMA_ORIGIN, SUMMARY_ORIGINS } from "@epoch-dev/scorers/origins";
import { LATEST_RELEASE_URL } from "./release";

/*
 * The egress session's own filter (ADR-016), a second layer behind the
 * network wrappers' allowlists: the model origins, and (ADR-018) one GET of
 * the latest-release URL; offline only the model on this machine. By origin,
 * or the exact URL, so a lookalike host, another port, path or scheme never
 * passes.
 */

export function egressAllows(
  url: string,
  offline: boolean,
  method = "GET",
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin === OLLAMA_ORIGIN) return true;
  if (offline) return false;
  if (url === LATEST_RELEASE_URL) return method === "GET";
  return (Object.values(SUMMARY_ORIGINS) as string[]).includes(parsed.origin);
}
