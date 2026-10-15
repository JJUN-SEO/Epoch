/** The canvas colors, read from the CSS design tokens in styles.css. */
export interface CanvasTheme {
  readonly canvas: string;
  readonly text: string;
  readonly muted: string;
  readonly faint: string;
  readonly border: string;
  readonly chrome: string;
  readonly accent: string;
  readonly imports: string;
  readonly dependents: string;
  readonly danger: string;
  readonly edge: string;
}

const FALLBACK: CanvasTheme = {
  canvas: "#ffffff",
  text: "#1c1c21",
  muted: "#6b6b76",
  faint: "#a3a3ad",
  border: "#e2e2e7",
  chrome: "#f4f4f6",
  accent: "#5b5bd6",
  imports: "#0f9d8f",
  dependents: "#dd6b20",
  danger: "#c4320a",
  edge: "#b9bcc6",
};

export function readCanvasTheme(): CanvasTheme {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) =>
    css.getPropertyValue(`--epoch-${name}`).trim() || fallback;
  return {
    canvas: get("canvas", FALLBACK.canvas),
    text: get("text", FALLBACK.text),
    muted: get("muted", FALLBACK.muted),
    faint: get("faint", FALLBACK.faint),
    border: get("border", FALLBACK.border),
    chrome: get("chrome", FALLBACK.chrome),
    accent: get("accent", FALLBACK.accent),
    imports: get("imports", FALLBACK.imports),
    dependents: get("dependents", FALLBACK.dependents),
    danger: get("danger", FALLBACK.danger),
    edge: get("edge", FALLBACK.edge),
  };
}

/** Calls `cb` when the OS theme flips; returns the unsubscribe. */
export function onThemeChange(cb: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", cb);
  return () => {
    media.removeEventListener("change", cb);
  };
}
