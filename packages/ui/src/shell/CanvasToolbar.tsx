import {
  ChevronsDownUp,
  ChevronsUpDown,
  Maximize,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { ColorBy } from "../graph/colors";
import { HOP_OPTIONS, type Hops } from "../components/NeighborsPanel";
import { IconButton, Segmented, Toggle } from "../components/ui";
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
  readonly hops: Hops;
  readonly onHops: (hops: Hops) => void;
  readonly onExpandAll: () => void;
  readonly onCollapseAll: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Canvas"
      className="border-line bg-raised/95 shadow-pop absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl border p-1 backdrop-blur"
    >
      <IconButton icon={ZoomOut} label="Zoom out" onClick={props.onZoomOut} />
      <IconButton icon={ZoomIn} label="Zoom in" onClick={props.onZoomIn} />
      <IconButton icon={Maximize} label="Fit to window" onClick={props.onFit} />
      <div className="bg-line mx-1 h-5 w-px" aria-hidden="true" />
      {props.view === "graph" ? (
        <>
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
        </>
      ) : (
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
        ]}
        value={props.colorBy}
        onChange={props.onColorBy}
      />
      <Toggle
        label="Barrel imports"
        title="Show the import of a barrel file itself (hidden by default; the real dependency is drawn either way)"
        checked={props.showViaBarrel}
        onChange={props.onShowViaBarrel}
      />
    </div>
  );
}
