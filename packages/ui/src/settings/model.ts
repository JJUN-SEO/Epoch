import type { KeyStatus } from "@epoch-dev/core";

/* Pure helpers behind the Settings view. */

/** Dollars: cents for most amounts, four decimals below a cent. */
export const usd = (n: number): string =>
  n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;

/**
 * A dollar field as typed: null when empty (clears the setting), the
 * amount, or undefined when it is not a usable amount.
 */
export function parseUsd(text: string): number | null | undefined {
  const t = text.trim().replace(/^\$/, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function keyStatusText(status: KeyStatus): string {
  if (!status.configured) return "Not set";
  switch (status.storage) {
    case "session":
      return "Set until Epoch quits";
    case "weak":
      return "Set, weakly protected (no keyring)";
    default:
      return "Set, encrypted by your system";
  }
}

export function bytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
