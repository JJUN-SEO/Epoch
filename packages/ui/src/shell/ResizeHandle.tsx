import { PANEL_MAX, PANEL_MIN } from "../prefs";

/** A thin drag handle on a panel's edge that resizes it. */
export function ResizeHandle(props: {
  readonly side: "left" | "right";
  readonly width: number;
  readonly onWidth: (width: number) => void;
  readonly label: string;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuemin={PANEL_MIN}
      aria-valuemax={PANEL_MAX}
      aria-valuenow={props.width}
      tabIndex={0}
      className="hover:bg-accent/40 active:bg-accent/60 relative z-10 -mx-0.5 w-1 shrink-0 cursor-col-resize transition-colors"
      onKeyDown={(e) => {
        const step =
          e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
        if (step === 0) return;
        e.preventDefault();
        const delta = props.side === "right" ? step : -step;
        props.onWidth(
          Math.min(PANEL_MAX, Math.max(PANEL_MIN, props.width + delta)),
        );
      }}
      onPointerDown={(e) => {
        const startX = e.clientX;
        const start = props.width;
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        const move = (m: PointerEvent) => {
          const dx = m.clientX - startX;
          const next = start + (props.side === "right" ? dx : -dx);
          props.onWidth(Math.min(PANEL_MAX, Math.max(PANEL_MIN, next)));
        };
        const up = () => {
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", up);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
      }}
    />
  );
}
