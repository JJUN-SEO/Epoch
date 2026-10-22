import type { ReactNode } from "react";
import { cx } from "../components/ui";

export type InspectorTab = "details" | "neighbors" | "impact";

/** The right-hand panel: details of the selection, the files around it, or its blast radius. */
export function Inspector(props: {
  readonly width: number;
  readonly tab: InspectorTab;
  readonly onTab: (tab: InspectorTab) => void;
  readonly details: ReactNode;
  readonly neighbors: ReactNode;
  readonly impact: ReactNode;
}) {
  const tabs: { id: InspectorTab; label: string }[] = [
    { id: "details", label: "Details" },
    { id: "neighbors", label: "Neighbors" },
    { id: "impact", label: "Impact" },
  ];
  return (
    <aside
      aria-label="Inspector"
      className="bg-chrome border-line flex shrink-0 flex-col border-l"
      style={{ width: props.width }}
    >
      <div
        role="tablist"
        aria-label="Inspector"
        className="border-line flex gap-1 border-b px-2 py-1.5"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`inspector-tab-${t.id}`}
            aria-selected={props.tab === t.id}
            aria-controls="inspector-panel"
            className={cx(
              "h-7 rounded-md px-2.5 text-[13px] font-medium transition-colors",
              props.tab === t.id
                ? "bg-active text-fg"
                : "text-muted hover:text-fg hover:bg-hover",
            )}
            onClick={() => {
              props.onTab(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        id="inspector-panel"
        role="tabpanel"
        aria-labelledby={`inspector-tab-${props.tab}`}
        className="min-h-0 flex-1 overflow-auto"
      >
        {props.tab === "details"
          ? props.details
          : props.tab === "neighbors"
            ? props.neighbors
            : props.impact}
      </div>
    </aside>
  );
}
