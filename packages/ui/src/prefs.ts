import { HINT_DEFAULTS } from "@epoch-dev/core";
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
  readonly inspectorTab: "details" | "neighbors" | "impact";
  /** The graph view's drawing: the 2D graph, or the optional 3D overview. */
  readonly graphMode: "2d" | "3d";
  /** Draw hint edges (likely relations); off by default, as CLAUDE.md's default display shows facts only. */
  readonly hints: boolean;
  /** The lowest hint confidence drawn, and the threshold of the blast radius's Likely mode. */
  readonly hintThreshold: number;
}

export const DEFAULT_PREFS: Prefs = {
  sidebar: true,
  inspector: true,
  sidebarWidth: 248,
  inspectorWidth: 340,
  colorBy: "folder",
  hops: 1,
  inspectorTab: "details",
  graphMode: "2d",
  hints: false,
  hintThreshold: HINT_DEFAULTS.threshold,
};

/** No hint edge is weaker than the floor, so the slider starts there. */
export const HINT_THRESHOLD_MIN = HINT_DEFAULTS.floor;
export const HINT_THRESHOLD_MAX = 0.95;
export const HINT_THRESHOLD_STEP = 0.05;

/** A threshold on the slider's steps, inside its range. */
export function clampThreshold(v: number): number {
  const stepped = Math.round(v / HINT_THRESHOLD_STEP) * HINT_THRESHOLD_STEP;
  return (
    Math.round(
      Math.min(HINT_THRESHOLD_MAX, Math.max(HINT_THRESHOLD_MIN, stepped)) * 100,
    ) / 100
  );
}

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
      r.colorBy === "language" || r.colorBy === "folder" || r.colorBy === "risk"
        ? r.colorBy
        : d.colorBy,
    hops: r.hops === 1 || r.hops === 2 || r.hops === 3 ? r.hops : d.hops,
    inspectorTab:
      r.inspectorTab === "details" ||
      r.inspectorTab === "neighbors" ||
      r.inspectorTab === "impact"
        ? r.inspectorTab
        : d.inspectorTab,
    graphMode:
      r.graphMode === "2d" || r.graphMode === "3d" ? r.graphMode : d.graphMode,
    hints: typeof r.hints === "boolean" ? r.hints : d.hints,
    hintThreshold:
      typeof r.hintThreshold === "number" && Number.isFinite(r.hintThreshold)
        ? clampThreshold(r.hintThreshold)
        : d.hintThreshold,
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
