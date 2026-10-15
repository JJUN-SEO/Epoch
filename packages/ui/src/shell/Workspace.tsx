import {
  ChevronLeft,
  ChevronRight,
  Crosshair,
  FolderOpen,
  Network,
  PanelLeft,
  PanelRight,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Graph, ProjectInfo } from "@epoch-dev/core";
import type { Shell } from "../api";
import { DetailsPanel } from "../components/DetailsPanel";
import { NeighborsPanel, type Hops } from "../components/NeighborsPanel";
import { IconButton, Kbd, Segmented } from "../components/ui";
import {
  aggregate,
  ancestors,
  dirPath,
  expandTo,
  initialExpanded,
  isDirId,
} from "../graph/aggregate";
import { nodeColors, type ColorBy } from "../graph/colors";
import type { CanvasControls } from "../graph/cy";
import { focusLayout, isGroupId, MAX_PER_COLUMN } from "../graph/focus-layout";
import { FocusView } from "../graph/FocusView";
import { GraphView } from "../graph/GraphView";
import { neighborhood } from "../graph/neighborhood";
import { isMac } from "../platform";
import { loadPrefs, savePrefs, type Prefs } from "../prefs";
import { CanvasToolbar } from "./CanvasToolbar";
import { CommandPalette } from "./CommandPalette";
import {
  isMenuCommand,
  SHORTCUTS,
  type Command,
  type CommandId,
} from "./commands";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { Inspector } from "./Inspector";
import { ResizeHandle } from "./ResizeHandle";
import { isTyping, matches, shortcutLabel } from "./shortcuts";
import { Sidebar, type View } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";

export interface WorkspaceProps {
  readonly project: ProjectInfo;
  readonly graph: Graph;
  /** Absent in the static demo, which opens nothing. */
  readonly shell?: Shell;
  readonly onOpenAnother?: () => void;
  readonly onOpenRecent?: (folder: string) => void;
}

interface FocusHistory {
  readonly stack: readonly string[];
  readonly index: number;
}

/** Two runs of one command this close together came from the menu and the key at once. */
const ECHO_MS = 150;

/**
 * The project window: title bar, sidebar (views and files), the canvas
 * (graph or focus view), the inspector, and the status bar.
 */
export function Workspace({
  project,
  graph,
  shell,
  onOpenAnother,
  onOpenRecent,
}: WorkspaceProps) {
  const mac = isMac();
  const nodeIds = useMemo(() => new Set(graph.nodes.map((n) => n.id)), [graph]);
  /** A file (or package) node, which can be the center of the focus view. */
  const isFileNode = useCallback(
    (id: string | undefined): id is string =>
      id !== undefined && nodeIds.has(id),
    [nodeIds],
  );
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);

  const [view, setView] = useState<View>("graph");
  const [expanded, setExpanded] = useState(() => initialExpanded(graph));
  const [showViaBarrel, setShowViaBarrel] = useState(false);
  const [selected, setSelected] = useState<string | undefined>();
  const [reveal, setReveal] = useState<{ id: string } | undefined>();
  const [history, setHistory] = useState<FocusHistory>({
    stack: [],
    index: -1,
  });
  const [openGroups, setOpenGroups] = useState<{
    center: string | undefined;
    ids: ReadonlySet<string>;
  }>({ center: undefined, ids: new Set() });
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState<
    { x: number; y: number; items: ContextMenuItem[] } | undefined
  >();
  const graphControls = useRef<CanvasControls | undefined>(undefined);
  const focusControls = useRef<CanvasControls | undefined>(undefined);

  const center = history.stack[history.index];
  const hops = prefs.hops;
  const colors = useMemo(
    () => nodeColors(graph, prefs.colorBy),
    [graph, prefs.colorBy],
  );
  const visible = useMemo(
    () => aggregate(graph, { expanded, showViaBarrel }),
    [graph, expanded, showViaBarrel],
  );
  const focusHood = useMemo(
    () =>
      center === undefined
        ? undefined
        : neighborhood(graph, center, { hops, showViaBarrel }),
    [graph, center, hops, showViaBarrel],
  );
  const groups =
    openGroups.center === center ? openGroups.ids : new Set<string>();
  const layout = useMemo(
    () =>
      focusHood === undefined
        ? undefined
        : focusLayout(focusHood, {
            maxPerColumn: MAX_PER_COLUMN,
            expandedGroups: groups,
          }),
    // `groups` is derived from openGroups and center.
    [focusHood, openGroups, center],
  );
  const selectedHood = useMemo(() => {
    if (!isFileNode(selected)) return undefined;
    if (selected === center && focusHood) return focusHood;
    return neighborhood(graph, selected, { hops, showViaBarrel });
  }, [graph, isFileNode, selected, center, focusHood, hops, showViaBarrel]);

  const inFocus = (id: string) =>
    layout?.nodes.some((n) => n.id === id) ?? false;

  /** Opens `id` in the focus view, as a new step of the focus history. */
  const focusOn = useCallback(
    (id: string) => {
      if (!isFileNode(id)) return;
      setHistory((h) => {
        if (h.stack[h.index] === id) return h;
        const stack = [...h.stack.slice(0, h.index + 1), id];
        return { stack, index: stack.length - 1 };
      });
      setSelected(id);
      setView("focus");
    },
    [isFileNode],
  );

  /** Shows a node: selects it, and brings it into view in the current canvas. */
  const show = (id: string) => {
    if (view === "focus" && !isDirId(id)) {
      if (inFocus(id)) setSelected(id);
      else focusOn(id);
      return;
    }
    setView("graph");
    setExpanded((e) => expandTo(e, id));
    setSelected(id);
    setReveal({ id });
  };

  const toggleDir = (id: string) => {
    const dir = dirPath(id);
    setExpanded((e) => {
      const next = new Set(e);
      if (next.has(dir)) {
        for (const d of next) {
          if (d === dir || d.startsWith(`${dir}/`)) next.delete(d);
        }
      } else {
        next.add(dir);
      }
      return next;
    });
  };

  const toggleGroup = (id: string) => {
    setOpenGroups((g) => {
      const ids = new Set(g.center === center ? g.ids : []);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { center, ids };
    });
  };

  const go = (delta: number) => {
    const index = Math.min(
      history.stack.length - 1,
      Math.max(0, history.index + delta),
    );
    const id = history.stack[index];
    if (index === history.index || id === undefined) return;
    setHistory({ ...history, index });
    setSelected(id);
    setView("focus");
  };

  const allDirs = useMemo(
    () => new Set(graph.nodes.flatMap((n) => ancestors(n.id))),
    [graph],
  );
  const canFocus = center !== undefined || isFileNode(selected);
  const controls = () =>
    view === "graph" ? graphControls.current : focusControls.current;

  const runners: Record<CommandId, () => void> = {
    palette: () => {
      setPalette((p) => !p);
    },
    "project.open": () => onOpenAnother?.(),
    "view.graph": () => {
      setView("graph");
      if (selected !== undefined) {
        setExpanded((e) => expandTo(e, selected));
        setReveal({ id: selected });
      }
    },
    "view.focus": () => {
      if (isFileNode(selected) && selected !== center) focusOn(selected);
      else if (center !== undefined) setView("focus");
    },
    "focus.selected": () => {
      if (selected !== undefined) focusOn(selected);
    },
    "nav.back": () => {
      go(-1);
    },
    "nav.forward": () => {
      go(1);
    },
    "panel.sidebar": () => {
      updatePrefs({ sidebar: !prefs.sidebar });
    },
    "panel.inspector": () => {
      updatePrefs({ inspector: !prefs.inspector });
    },
    "graph.fit": () => controls()?.fit(),
    "graph.barrels": () => {
      setShowViaBarrel((s) => !s);
    },
    "graph.expandAll": () => {
      setExpanded(new Set(allDirs));
    },
    "graph.collapseAll": () => {
      setExpanded(new Set());
    },
    "graph.colorBy": () => {
      updatePrefs({
        colorBy: prefs.colorBy === "folder" ? "language" : "folder",
      });
    },
  };

  const entries: { id: CommandId; title: string; enabled: boolean }[] = [
    {
      id: "project.open",
      title: "Open Project…",
      enabled: onOpenAnother !== undefined,
    },
    { id: "view.graph", title: "Show Graph", enabled: view !== "graph" },
    { id: "view.focus", title: "Show Focus View", enabled: canFocus },
    {
      id: "focus.selected",
      title: "Focus on Selected File",
      enabled: isFileNode(selected),
    },
    { id: "nav.back", title: "Back", enabled: history.index > 0 },
    {
      id: "nav.forward",
      title: "Forward",
      enabled: history.index < history.stack.length - 1,
    },
    {
      id: "panel.sidebar",
      title: prefs.sidebar ? "Hide Sidebar" : "Show Sidebar",
      enabled: true,
    },
    {
      id: "panel.inspector",
      title: prefs.inspector ? "Hide Inspector" : "Show Inspector",
      enabled: true,
    },
    { id: "graph.fit", title: "Fit to Window", enabled: true },
    {
      id: "graph.barrels",
      title: showViaBarrel ? "Hide Barrel Imports" : "Show Barrel Imports",
      enabled: true,
    },
    {
      id: "graph.expandAll",
      title: "Expand All Folders",
      enabled: view === "graph",
    },
    {
      id: "graph.collapseAll",
      title: "Collapse All Folders",
      enabled: view === "graph",
    },
    {
      id: "graph.colorBy",
      title:
        prefs.colorBy === "folder" ? "Color by Language" : "Color by Folder",
      enabled: true,
    },
  ];
  const commands: Command[] = entries.map((c) => {
    const shortcut = SHORTCUTS[c.id];
    return { ...c, ...(shortcut ? { shortcut } : {}), run: runners[c.id] };
  });

  // One entry point for shortcuts and menu commands; drop the echo when a
  // key reaches both the native menu and this page.
  const runnersRef = useRef(runners);
  runnersRef.current = runners;
  const last = useRef({ id: "", source: "", at: 0 });
  const run = useCallback((id: CommandId, source: "key" | "menu") => {
    const now = performance.now();
    const l = last.current;
    if (l.id === id && l.source !== source && now - l.at < ECHO_MS) return;
    last.current = { id, source, at: now };
    runnersRef.current[id]();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const [id, shortcut] of Object.entries(SHORTCUTS)) {
        if (!matches(e, shortcut, mac)) continue;
        if (!shortcut.mod && isTyping(e.target)) return;
        e.preventDefault();
        run(id as CommandId, "key");
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [mac, run]);

  useEffect(
    () =>
      shell?.onMenuCommand((id) => {
        if (isMenuCommand(id)) run(id, "menu");
      }),
    [shell, run],
  );

  const contextItems = (id: string): ContextMenuItem[] => {
    if (isGroupId(id))
      return [
        {
          label: "Open or close group",
          run: () => {
            toggleGroup(id);
          },
        },
      ];
    if (isDirId(id)) {
      return [
        {
          label: expanded.has(dirPath(id)) ? "Close folder" : "Open folder",
          run: () => {
            toggleDir(id);
          },
        },
        {
          label: "Select",
          run: () => {
            setSelected(id);
          },
        },
      ];
    }
    return [
      {
        label: "Focus on this file",
        run: () => {
          focusOn(id);
        },
      },
      ...(view === "focus"
        ? [
            {
              label: "Show in graph",
              run: () => {
                setView("graph");
                setExpanded((e) => expandTo(e, id));
                setSelected(id);
                setReveal({ id });
              },
            },
          ]
        : []),
      {
        label: "Select",
        run: () => {
          setSelected(id);
        },
      },
    ];
  };

  const openMenu = (id: string, x: number, y: number) => {
    setMenu({ x, y, items: contextItems(id) });
  };

  const paletteShortcut = SHORTCUTS.palette;

  return (
    <div className="flex h-full flex-col">
      <TitleBar
        desktop={shell !== undefined}
        onAppMenu={
          shell
            ? (x, y) => {
                shell.showAppMenu(x, y);
              }
            : undefined
        }
      >
        <IconButton
          icon={PanelLeft}
          label={prefs.sidebar ? "Hide sidebar" : "Show sidebar"}
          shortcut={
            SHORTCUTS["panel.sidebar"] &&
            shortcutLabel(SHORTCUTS["panel.sidebar"], mac)
          }
          active={prefs.sidebar}
          onClick={() => {
            run("panel.sidebar", "key");
          }}
        />
        {!prefs.sidebar && (
          <span
            className="truncate px-1 text-[13px] font-semibold"
            title={project.root}
          >
            {project.name}
          </span>
        )}
        <IconButton
          icon={ChevronLeft}
          label="Back"
          shortcut={
            SHORTCUTS["nav.back"] && shortcutLabel(SHORTCUTS["nav.back"], mac)
          }
          disabled={history.index <= 0}
          onClick={() => {
            go(-1);
          }}
        />
        <IconButton
          icon={ChevronRight}
          label="Forward"
          shortcut={
            SHORTCUTS["nav.forward"] &&
            shortcutLabel(SHORTCUTS["nav.forward"], mac)
          }
          disabled={history.index >= history.stack.length - 1}
          onClick={() => {
            go(1);
          }}
        />
        <div className="ml-1">
          <Segmented
            label="View"
            value={view}
            onChange={(v) => {
              run(v === "graph" ? "view.graph" : "view.focus", "key");
            }}
            options={[
              { value: "graph", label: "Graph", icon: Network },
              {
                value: "focus",
                label: "Focus",
                icon: Crosshair,
                disabled: !canFocus,
                title: canFocus ? "Focus view" : "Select a file first",
              },
            ]}
          />
        </div>
        <div className="flex min-w-0 flex-1 justify-center px-3">
          <button
            type="button"
            aria-label="Search files and commands"
            className="no-drag border-line bg-canvas/70 text-muted hover:text-fg hover:border-strong-line flex h-7 w-full max-w-[360px] min-w-0 items-center gap-2 rounded-md border px-2.5 text-[13px]"
            onClick={() => {
              setPalette(true);
            }}
          >
            <Search size={14} aria-hidden="true" />
            <span className="flex-1 truncate text-left">
              Search files and commands…
            </span>
            {paletteShortcut && (
              <Kbd>{shortcutLabel(paletteShortcut, mac)}</Kbd>
            )}
          </button>
        </div>
        {onOpenAnother && (
          <IconButton
            icon={FolderOpen}
            label="Open Project…"
            shortcut={
              SHORTCUTS["project.open"] &&
              shortcutLabel(SHORTCUTS["project.open"], mac)
            }
            onClick={onOpenAnother}
          />
        )}
        <IconButton
          icon={PanelRight}
          label={prefs.inspector ? "Hide inspector" : "Show inspector"}
          shortcut={
            SHORTCUTS["panel.inspector"] &&
            shortcutLabel(SHORTCUTS["panel.inspector"], mac)
          }
          active={prefs.inspector}
          onClick={() => {
            run("panel.inspector", "key");
          }}
        />
      </TitleBar>

      <div className="flex min-h-0 flex-1">
        {prefs.sidebar && (
          <>
            <Sidebar
              width={prefs.sidebarWidth}
              project={project}
              graph={graph}
              shell={shell}
              view={view}
              canFocus={canFocus}
              onView={(v) => {
                run(v === "graph" ? "view.graph" : "view.focus", "key");
              }}
              selected={selected}
              onSelect={show}
              onActivate={focusOn}
              onOpenAnother={onOpenAnother}
              onOpenRecent={onOpenRecent}
            />
            <ResizeHandle
              side="right"
              label="Resize sidebar"
              width={prefs.sidebarWidth}
              onWidth={(w) => {
                updatePrefs({ sidebarWidth: w });
              }}
            />
          </>
        )}

        <main className="bg-canvas relative min-w-0 flex-1" aria-label="Canvas">
          <div className={view === "graph" ? "h-full" : "hidden"}>
            <GraphView
              active={view === "graph"}
              visible={visible}
              colors={colors}
              selected={selected}
              reveal={reveal}
              onSelect={setSelected}
              onActivate={(id) => {
                if (isDirId(id)) toggleDir(id);
                else focusOn(id);
              }}
              onContextMenu={openMenu}
              controlsRef={graphControls}
            />
          </div>
          {layout !== undefined && (
            <div className={view === "focus" ? "h-full" : "hidden"}>
              <FocusView
                active={view === "focus"}
                graph={graph}
                layout={layout}
                colors={colors}
                selected={selected}
                onSelect={(id) => {
                  if (id !== undefined && isGroupId(id)) toggleGroup(id);
                  else setSelected(id);
                }}
                onActivate={(id) => {
                  if (isGroupId(id)) return;
                  focusOn(id);
                }}
                onContextMenu={openMenu}
                controlsRef={focusControls}
              />
            </div>
          )}
          {view === "focus" && center !== undefined && (
            <div className="bg-raised/90 border-line text-muted pointer-events-none absolute top-3 left-3 flex items-center gap-3 rounded-lg border px-2.5 py-1.5 text-[11px] backdrop-blur">
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="bg-dependents size-2 rounded-full"
                  aria-hidden="true"
                />
                Imported by
              </span>
              <span className="inline-flex items-center gap-1.5">
                Imports
                <span
                  className="bg-imports size-2 rounded-full"
                  aria-hidden="true"
                />
              </span>
            </div>
          )}
          <CanvasToolbar
            view={view}
            onZoomIn={() => controls()?.zoomIn()}
            onZoomOut={() => controls()?.zoomOut()}
            onFit={() => controls()?.fit()}
            colorBy={prefs.colorBy}
            onColorBy={(by: ColorBy) => {
              updatePrefs({ colorBy: by });
            }}
            showViaBarrel={showViaBarrel}
            onShowViaBarrel={setShowViaBarrel}
            hops={hops}
            onHops={(h: Hops) => {
              updatePrefs({ hops: h });
            }}
            onExpandAll={() => {
              setExpanded(new Set(allDirs));
            }}
            onCollapseAll={() => {
              setExpanded(new Set());
            }}
          />
          {menu && (
            <ContextMenu
              x={menu.x}
              y={menu.y}
              items={menu.items}
              onClose={() => {
                setMenu(undefined);
              }}
            />
          )}
        </main>

        {prefs.inspector && (
          <>
            <ResizeHandle
              side="left"
              label="Resize inspector"
              width={prefs.inspectorWidth}
              onWidth={(w) => {
                updatePrefs({ inspectorWidth: w });
              }}
            />
            <Inspector
              width={prefs.inspectorWidth}
              tab={prefs.inspectorTab}
              onTab={(t) => {
                updatePrefs({ inspectorTab: t });
              }}
              details={
                <DetailsPanel
                  graph={graph}
                  selected={selected}
                  onShow={show}
                  onFocus={focusOn}
                  folderOpen={
                    selected !== undefined && expanded.has(dirPath(selected))
                  }
                  onToggleFolder={toggleDir}
                />
              }
              neighbors={
                <NeighborsPanel
                  graph={graph}
                  selected={selected}
                  hood={selectedHood}
                  hops={hops}
                  onHops={(h) => {
                    updatePrefs({ hops: h });
                  }}
                  onSelect={show}
                  onFocus={focusOn}
                />
              }
            />
          </>
        )}
      </div>

      <StatusBar graph={graph} />

      {palette && (
        <CommandPalette
          files={graph.nodes.map((n) => n.id)}
          commands={commands}
          onOpenFile={show}
          onClose={() => {
            setPalette(false);
          }}
        />
      )}
    </div>
  );
}
