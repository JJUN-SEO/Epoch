import type { Shortcut } from "./shortcuts";

/** Commands with a fixed id: the palette, shortcuts and the native menu run them. */
export type CommandId =
  | "palette"
  | "project.open"
  | "view.graph"
  | "view.focus"
  | "focus.selected"
  | "nav.back"
  | "nav.forward"
  | "panel.sidebar"
  | "panel.inspector"
  | "graph.fit"
  | "graph.barrels"
  | "graph.expandAll"
  | "graph.collapseAll"
  | "graph.colorBy";

/** What the native menu may ask for (main sends one of these; anything else is ignored). */
export const MENU_COMMANDS: readonly CommandId[] = [
  "palette",
  "view.graph",
  "view.focus",
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
  "project.open": { mod: true, key: "o" },
  "view.graph": { mod: true, code: "Digit1" },
  "view.focus": { mod: true, code: "Digit2" },
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
