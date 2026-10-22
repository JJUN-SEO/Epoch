import {
  ChevronsDownUp,
  ChevronsUpDown,
  Maximize,
  Radar,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { ColorBy } from "../graph/colors";
import { HOP_OPTIONS, type Hops } from "../components/NeighborsPanel";
import { IconButton, Segmented, Slider, Toggle } from "../components/ui";
import {
  HINT_THRESHOLD_MAX,
  HINT_THRESHOLD_MIN,
  HINT_THRESHOLD_STEP,
} from "../prefs";
import type { View } from "./Sidebar";

/** The floating toolbar over the canvas. */
export function CanvasToolbar(props: {
  readonly view: View;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onFit: () => void;
  readonly colorBy: ColorBy;
  readonly onColorBy: (by: ColorBy) => void;
  readonly showViaBarrel: boolean;
  readonly onShowViaBarrel: (show: boolean) => void;
  /** Hint edges (likely relations) drawn, dashed, at or above the threshold. */
  readonly hints: boolean;
  readonly onHints: (show: boolean) => void;
  readonly hintThreshold: number;
  readonly onHintThreshold: (threshold: number) => void;
  /** Hint edges in this analysis. */
  readonly hintCount: number;
  readonly hops: Hops;
  readonly onHops: (hops: Hops) => void;
  readonly onExpandAll: () => void;
  readonly onCollapseAll: () => void;
  /** Back to the folders open when the project opened, fitted. */
  readonly onResetFolders: () => void;
  readonly dimensions: "2d" | "3d";
  readonly onDimensions: (d: "2d" | "3d") => void;
  /** This computer can draw the 3D view. */
  readonly webgl: boolean;
  /** The blast radius of the selection is drawn on the graph. */
  readonly impact: boolean;
  readonly impactEnabled: boolean;
  readonly onImpact: () => void;
  /** Fade files without open findings (graph view). */
  readonly findingsOnly: boolean;
  readonly onFindingsOnly: (on: boolean) => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Canvas"
      className="border-line bg-raised/95 shadow-pop absolute bottom-4 left-1/2 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-xl border p-1 backdrop-blur"
    >
      <IconButton icon={ZoomOut} label="Zoom out" onClick={props.onZoomOut} />
      <IconButton icon={ZoomIn} label="Zoom in" onClick={props.onZoomIn} />
      <IconButton icon={Maximize} label="Fit to window" onClick={props.onFit} />
      <div className="bg-line mx-1 h-5 w-px" aria-hidden="true" />
      {props.view === "graph" && (
        <Segmented
          label="Dimensions"
          options={[
            { value: "2d", label: "2D", title: "2D graph" },
            {
              value: "3d",
              label: "3D",
              disabled: !props.webgl,
              title: props.webgl
                ? "3D overview"
                : "3D needs WebGL, which is unavailable on this computer",
            },
          ]}
          value={props.dimensions}
          onChange={props.onDimensions}
        />
      )}
      {props.view === "graph" && props.dimensions === "2d" && (
        <>
          <button
            type="button"
            aria-pressed={props.impact}
            disabled={!props.impactEnabled}
            title={
              props.impactEnabled
                ? "Blast radius: color what depends on the selected file, by distance"
                : "Select a file to see its blast radius"
            }
            onClick={props.onImpact}
            className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors disabled:opacity-35 ${props.impact ? "bg-active text-fg" : "text-muted hover:text-fg hover:bg-hover"}`}
          >
            <Radar size={14} aria-hidden="true" />
            Blast radius
          </button>
          <IconButton
            icon={ChevronsUpDown}
            label="Expand all folders"
            onClick={props.onExpandAll}
          />
          <IconButton
            icon={ChevronsDownUp}
            label="Collapse all folders"
            onClick={props.onCollapseAll}
          />
          <IconButton
            icon={RotateCcw}
            label="Back to the starting view"
            onClick={props.onResetFolders}
          />
        </>
      )}
      {props.view === "focus" && (
        <Segmented
          label="Hops"
          options={HOP_OPTIONS}
          value={props.hops}
          onChange={props.onHops}
        />
      )}
      <div className="bg-line mx-1 h-5 w-px" aria-hidden="true" />
      <Segmented
        label="Color by"
        options={[
          { value: "folder", label: "Folder" },
          { value: "language", label: "Language" },
          { value: "risk", label: "Risk" },
        ]}
        value={props.colorBy}
        onChange={props.onColorBy}
      />
      {props.view === "graph" && props.dimensions === "2d" && (
        <Toggle
          label="Findings only"
          title="Fade the files that no open finding mentions"
          checked={props.findingsOnly}
          onChange={props.onFindingsOnly}
        />
      )}
      <Toggle
        label="Barrel imports"
        title="Show the import of a barrel file itself (hidden by default; the real dependency is drawn either way)"
        checked={props.showViaBarrel}
        onChange={props.onShowViaBarrel}
      />
      <Toggle
        label="Hints"
        title={
          props.hintCount === 0
            ? "No likely relations in this analysis (they come from git co-change and shared strings)"
            : `Draw ${String(props.hintCount)} likely relations as dashed edges: inferred from git co-change and shared strings, not proven imports`
        }
        checked={props.hints}
        onChange={props.onHints}
      />
      {props.hints && (
        <Slider
          label="Lowest hint confidence"
          title="Hide likely relations below this confidence; the Likely blast radius uses the same threshold"
          value={props.hintThreshold}
          min={HINT_THRESHOLD_MIN}
          max={HINT_THRESHOLD_MAX}
          step={HINT_THRESHOLD_STEP}
          onChange={props.onHintThreshold}
          format={(v) => `≥ ${v.toFixed(2)}`}
        />
      )}
    </div>
  );
}
