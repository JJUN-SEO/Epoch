import type { ColorBy } from "./graph/colors";

/*
 * Per-user UI conveniences (panel sizes, last choices), kept in this
 * renderer's localStorage. Never project data. Storage can be missing or
 * throw, and whatever it holds is checked, so a bad value falls back to the
 * default instead of breaking the window.
 */

export interface Prefs {
  readonly sidebar: boolean;
  readonly inspector: boolean;
  readonly sidebarWidth: number;
  readonly inspectorWidth: number;
  readonly colorBy: ColorBy;
  readonly hops: 1 | 2 | 3;
  readonly inspectorTab: "details" | "neighbors";
}

export const DEFAULT_PREFS: Prefs = {
  sidebar: true,
  inspector: true,
  sidebarWidth: 248,
  inspectorWidth: 340,
  colorBy: "folder",
  hops: 1,
  inspectorTab: "details",
};

export const PANEL_MIN = 200;
export const PANEL_MAX = 520;

const KEY = "epoch.prefs";

const clampWidth = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(v)))
    : fallback;

/** Prefs from a stored value, field by field, defaulting anything invalid. */
export function parsePrefs(raw: unknown): Prefs {
  const r =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const d = DEFAULT_PREFS;
  return {
    sidebar: typeof r.sidebar === "boolean" ? r.sidebar : d.sidebar,
    inspector: typeof r.inspector === "boolean" ? r.inspector : d.inspector,
    sidebarWidth: clampWidth(r.sidebarWidth, d.sidebarWidth),
    inspectorWidth: clampWidth(r.inspectorWidth, d.inspectorWidth),
    colorBy:
      r.colorBy === "language" || r.colorBy === "folder"
        ? r.colorBy
        : d.colorBy,
    hops: r.hops === 1 || r.hops === 2 || r.hops === 3 ? r.hops : d.hops,
    inspectorTab:
      r.inspectorTab === "details" || r.inspectorTab === "neighbors"
        ? r.inspectorTab
        : d.inspectorTab,
  };
}

export function loadPrefs(): Prefs {
  try {
    const text = window.localStorage.getItem(KEY);
    return parsePrefs(text === null ? {} : JSON.parse(text));
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // not persisted; harmless
  }
}
