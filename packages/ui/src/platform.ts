/**
 * macOS or not, from the renderer itself (no IPC): it decides the title bar
 * layout (traffic lights on the left vs. window buttons on the right) and
 * how shortcuts are written (⌘K vs Ctrl+K).
 */
export const isMac = (): boolean =>
  typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
