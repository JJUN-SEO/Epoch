/*
 * Keyboard shortcuts, matched in the renderer. On macOS the native menu
 * catches its accelerators first and sends the command over IPC; on Windows
 * and Linux the menu only displays them (registerAccelerator: false), so the
 * key arrives here. Either way one command runs.
 */

export interface Shortcut {
  /** ⌘ on macOS, Ctrl elsewhere. */
  readonly mod?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  /** KeyboardEvent.key, lowercase, for letters. */
  readonly key?: string;
  /** KeyboardEvent.code, for keys whose character depends on the layout. */
  readonly code?: string;
}

type KeyLike = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

export function matches(e: KeyLike, s: Shortcut, mac: boolean): boolean {
  const mod = mac ? e.metaKey : e.ctrlKey;
  const other = mac ? e.ctrlKey : e.metaKey;
  if (Boolean(s.mod) !== mod || other) return false;
  if (Boolean(s.alt) !== e.altKey || Boolean(s.shift) !== e.shiftKey) {
    return false;
  }
  if (s.code !== undefined) return e.code === s.code;
  return s.key !== undefined && e.key.toLowerCase() === s.key;
}

const CODE_LABELS: Readonly<Record<string, string>> = {
  BracketLeft: "[",
  BracketRight: "]",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
};

/** "⌘⌥B" on macOS, "Ctrl+Alt+B" elsewhere. */
export function shortcutLabel(s: Shortcut, mac: boolean): string {
  const key =
    s.code !== undefined
      ? (CODE_LABELS[s.code] ?? s.code.replace(/^Key/, ""))
      : (s.key ?? "").toUpperCase();
  if (mac) {
    return `${s.mod ? "⌘" : ""}${s.alt ? "⌥" : ""}${s.shift ? "⇧" : ""}${key}`;
  }
  return [s.mod ? "Ctrl" : "", s.alt ? "Alt" : "", s.shift ? "Shift" : "", key]
    .filter((p) => p !== "")
    .join("+");
}

/** True when the key is meant for a text field, not for a shortcut. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}
