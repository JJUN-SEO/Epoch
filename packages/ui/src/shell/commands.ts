import type { Shortcut } from "./shortcuts";

/** Commands with a fixed id: the palette, shortcuts and the native menu run them. */
export type CommandId =
  | "palette"
  | "settings"
  | "project.open"
  | "view.graph"
  | "view.focus"
  | "view.findings"
  | "focus.selected"
  | "nav.back"
  | "nav.forward"
  | "panel.sidebar"
  | "panel.inspector"
  | "graph.fit"
  | "graph.barrels"
  | "graph.hints"
  | "graph.expandAll"
  | "graph.collapseAll"
  | "graph.resetFolders"
  | "graph.colorBy"
  | "graph.dimensions"
  | "graph.blastRadius"
  | "graph.findingsOnly";

/** What the native menu may ask for (main sends one of these; anything else is ignored). */
export const MENU_COMMANDS: readonly CommandId[] = [
  "palette",
  "settings",
  "view.graph",
  "view.focus",
  "view.findings",
  "nav.back",
  "nav.forward",
  "panel.sidebar",
  "panel.inspector",
];

export const isMenuCommand = (id: string): id is CommandId =>
  (MENU_COMMANDS as readonly string[]).includes(id);

/** Matches the accelerators of the native menu (packages/app/src/main/menu.ts). */
export const SHORTCUTS: Readonly<Partial<Record<CommandId, Shortcut>>> = {
  palette: { mod: true, key: "k" },
  settings: { mod: true, code: "Comma" },
  "project.open": { mod: true, key: "o" },
  "view.graph": { mod: true, code: "Digit1" },
  "view.focus": { mod: true, code: "Digit2" },
  "view.findings": { mod: true, code: "Digit3" },
  "nav.back": { mod: true, code: "BracketLeft" },
  "nav.forward": { mod: true, code: "BracketRight" },
  "panel.sidebar": { mod: true, key: "b" },
  "panel.inspector": { mod: true, alt: true, code: "KeyB" },
  "focus.selected": { key: "f" },
};

export interface Command {
  readonly id: string;
  readonly title: string;
  readonly enabled: boolean;
  readonly shortcut?: Shortcut;
  readonly run: () => void;
}
