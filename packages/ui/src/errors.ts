/**
 * A readable message for an error from IPC. Electron wraps errors thrown in
 * main as "Error invoking remote method '<channel>': <Name>: <message>".
 */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/^Error invoking remote method '[^']*': /, "")
    .replace(/^(?:[A-Z][A-Za-z]*)?Error: /, "");
}
