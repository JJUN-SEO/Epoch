import { ChevronDown, Crosshair, FolderOpen, Network } from "lucide-react";
import { useState } from "react";
import type { Graph, ProjectInfo } from "@epoch-dev/core";
import type { Shell } from "../api";
import { cx, SectionTitle } from "../components/ui";
import { isMac } from "../platform";
import { SHORTCUTS } from "./commands";
import { FileTree } from "./FileTree";
import { MenuItem, MenuSeparator, Popover } from "./Popover";
import { shortcutLabel } from "./shortcuts";

export type View = "graph" | "focus";

const folderName = (p: string): string =>
  p
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) ?? p;

function ProjectSwitcher(props: {
  readonly project: ProjectInfo;
  readonly shell: Shell | undefined;
  readonly onOpenAnother: (() => void) | undefined;
  readonly onOpenRecent: ((folder: string) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const mac = isMac();
  const shortcut = SHORTCUTS["project.open"];
  return (
    <div className="relative px-2 pt-2">
      <button
        type="button"
        className="hover:bg-hover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
        title={props.project.root}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={props.shell === undefined}
        onClick={() => {
          setOpen((o) => !o);
          props.shell?.recentProjects().then(setRecent, () => undefined);
        }}
      >
        <span className="bg-accent text-on-accent flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-bold">
          {props.project.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">
            {props.project.name}
          </span>
          <span className="text-muted block truncate text-[11px]">
            {props.project.root}
          </span>
        </span>
        {props.shell && (
          <ChevronDown
            size={14}
            aria-hidden="true"
            className="text-muted shrink-0"
          />
        )}
      </button>
      {open && (
        <Popover
          label="Projects"
          className="top-full right-2 left-2 mt-1"
          onClose={() => {
            setOpen(false);
          }}
        >
          <MenuItem
            onSelect={() => {
              setOpen(false);
              props.onOpenAnother?.();
            }}
          >
            <FolderOpen size={14} aria-hidden="true" />
            <span className="flex-1">Open Project…</span>
            {shortcut && (
              <span className="text-[11px] opacity-70">
                {shortcutLabel(shortcut, mac)}
              </span>
            )}
          </MenuItem>
          {recent.filter((r) => r !== props.project.root).length > 0 && (
            <MenuSeparator />
          )}
          {recent
            .filter((r) => r !== props.project.root)
            .slice(0, 8)
            .map((folder) => (
              <MenuItem
                key={folder}
                title={folder}
                onSelect={() => {
                  setOpen(false);
                  props.onOpenRecent?.(folder);
                }}
              >
                <span className="min-w-0 flex-1 truncate">
                  {folderName(folder)}
                </span>
              </MenuItem>
            ))}
        </Popover>
      )}
    </div>
  );
}

export function Sidebar(props: {
  readonly width: number;
  readonly project: ProjectInfo;
  readonly graph: Graph;
  readonly shell: Shell | undefined;
  readonly view: View;
  readonly canFocus: boolean;
  readonly onView: (view: View) => void;
  readonly selected: string | undefined;
  readonly onSelect: (id: string) => void;
  readonly onActivate: (id: string) => void;
  readonly onOpenAnother: (() => void) | undefined;
  readonly onOpenRecent: ((folder: string) => void) | undefined;
}) {
  const mac = isMac();
  const views = [
    {
      id: "graph" as const,
      label: "Graph",
      icon: Network,
      shortcut: SHORTCUTS["view.graph"],
    },
    {
      id: "focus" as const,
      label: "Focus",
      icon: Crosshair,
      shortcut: SHORTCUTS["view.focus"],
    },
  ];
  return (
    <nav
      aria-label="Sidebar"
      className="bg-chrome border-line flex shrink-0 flex-col border-r"
      style={{ width: props.width }}
    >
      <ProjectSwitcher
        project={props.project}
        shell={props.shell}
        onOpenAnother={props.onOpenAnother}
        onOpenRecent={props.onOpenRecent}
      />
      <SectionTitle>Views</SectionTitle>
      <ul className="px-1.5">
        {views.map((v) => (
          <li key={v.id}>
            <button
              type="button"
              aria-current={props.view === v.id ? "page" : undefined}
              disabled={v.id === "focus" && !props.canFocus}
              title={
                v.id === "focus" && !props.canFocus
                  ? "Select a file first"
                  : undefined
              }
              className={cx(
                "hover:bg-hover flex h-7 w-full items-center gap-2 rounded-md px-2 text-left disabled:opacity-40 disabled:hover:bg-transparent",
                props.view === v.id && "bg-active font-medium",
              )}
              onClick={() => {
                props.onView(v.id);
              }}
            >
              <v.icon size={15} strokeWidth={1.75} aria-hidden="true" />
              <span className="flex-1">{v.label}</span>
              {v.shortcut && (
                <span className="text-faint text-[11px]">
                  {shortcutLabel(v.shortcut, mac)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <SectionTitle>Files</SectionTitle>
      <div className="min-h-0 flex-1 overflow-auto">
        <FileTree
          graph={props.graph}
          selected={props.selected}
          onSelect={props.onSelect}
          onActivate={props.onActivate}
        />
      </div>
    </nav>
  );
}
