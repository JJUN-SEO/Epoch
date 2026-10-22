/**
 * A readable message for an error from IPC. Electron wraps errors thrown in
 * main as "Error invoking remote method '<channel>': <Name>: <message>".
 */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const unwrapped = raw.replace(/^Error invoking remote method '[^']*': /, "");
  // After the IPC wrapper comes the error's class name ("SettingsNotConfirmed:").
  return unwrapped === raw
    ? raw.replace(/^(?:[A-Z][A-Za-z]*)?Error: /, "")
    : unwrapped.replace(/^[A-Z][A-Za-z]*: /, "");
}
