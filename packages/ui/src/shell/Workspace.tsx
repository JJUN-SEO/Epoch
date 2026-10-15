import {
  ChevronLeft,
  ChevronRight,
  Crosshair,
  FolderOpen,
  Lightbulb,
  Network,
  PanelLeft,
  PanelRight,
  Search,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  atLeast,
  blastRadius,
  type AnalysisInfo,
  type Confidence,
  type EpochApi,
  type Graph,
  type ProjectInfo,
  type WatchStatus,
} from "@epoch-dev/core";
import type { Shell } from "../api";
import { DetailsPanel } from "../components/DetailsPanel";
import { ImpactPanel, type ImpactSettings } from "../components/ImpactPanel";
import { NeighborsPanel, type Hops } from "../components/NeighborsPanel";
import { IconButton, Kbd, Segmented } from "../components/ui";
import {
  aggregate,
  ancestors,
  dirPath,
  expandTo,
  initialExpanded,
  isDirId,
  representative,
} from "../graph/aggregate";
import { nodeColors, type ColorBy } from "../graph/colors";
import type { CanvasControls } from "../graph/cy";
import { focusLayout, isGroupId, MAX_PER_COLUMN } from "../graph/focus-layout";
import { FocusView } from "../graph/FocusView";
import { GraphView } from "../graph/GraphView";
import { neighborhood } from "../graph/neighborhood";
import { FindingDetails } from "../findings/FindingDetails";
import { FindingsBanner } from "../findings/FindingsBanner";
import { FindingsView } from "../findings/FindingsView";
import { nodeRings, summarize } from "../findings/model";
import { useFindings } from "../findings/useFindings";
import { graph3dData } from "../graph3d/data";
import { webglAvailable } from "../graph3d/support";
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

/** The 3D overview (three.js) is its own chunk, loaded on first use. */
const Graph3DView = lazy(() => import("../graph3d/Graph3DView"));

export interface WorkspaceProps {
  /** Findings, dismissals and code previews go through the EpochApi. */
  readonly api: EpochApi;
  readonly project: ProjectInfo;
  readonly graph: Graph;
  /** The file watcher's state (the desktop app). */
  readonly watch?: WatchStatus | undefined;
  /** What the latest analysis used: git history, coverage. */
  readonly analysis?: AnalysisInfo | null;
  /** When the watcher last changed the graph. */
  readonly updatedAt?: Date | undefined;
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

const NEXT_COLOR_BY: Readonly<Record<ColorBy, ColorBy>> = {
  folder: "language",
  language: "risk",
  risk: "folder",
};
const VIEW_COMMANDS: Readonly<Record<View, CommandId>> = {
  graph: "view.graph",
  focus: "view.focus",
  findings: "view.findings",
};
const COLOR_BY_NAMES: Readonly<Record<ColorBy, string>> = {
  folder: "Folder",
  language: "Language",
  risk: "Risk",
};

/**
 * The project window: title bar, sidebar (views and files), the canvas
 * (graph or focus view), the inspector, and the status bar.
 */
export function Workspace({
  api,
  project,
  graph,
  watch,
  analysis,
  updatedAt,
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
  const graph3dControls = useRef<CanvasControls | undefined>(undefined);
  const webgl = useMemo(webglAvailable, []);
  const mode3d = prefs.graphMode === "3d" && webgl;
  const data3d = useMemo(
    () => (mode3d ? graph3dData(graph, showViaBarrel) : undefined),
    [mode3d, graph, showViaBarrel],
  );
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

  const [watchNoticeClosed, setWatchNoticeClosed] = useState(false);

  // Findings (M5): open ones, the banner's counts, rings on the graph.
  const findings = useFindings(api, graph, shell !== undefined);
  const findingsLevel: Confidence =
    analysis?.findings.minConfidence ?? "medium";
  const summary = useMemo(
    () => summarize(graph.findings, findings.open, findingsLevel),
    [graph, findings.open, findingsLevel],
  );
  /** The banner stays hidden after closing until its count changes. */
  const [bannerClosedAt, setBannerClosedAt] = useState<number | undefined>();
  const [selectedFinding, setSelectedFinding] = useState<string | undefined>();
  const finding = graph.findings.find((f) => f.id === selectedFinding);
  const [findingsOnly, setFindingsOnly] = useState(false);
  const rings = useMemo(
    () => nodeRings(graph, graph.findings, findings.open),
    [graph, findings.open],
  );
  /** Rings on what is drawn: a closed folder carries its files' highest level. */
  const visibleRings = useMemo(() => {
    const out = new Map<string, Confidence>();
    for (const [id, level] of rings) {
      const rep = representative(id, expanded, graph);
      const had = out.get(rep);
      if (had === undefined || atLeast(level, had)) out.set(rep, level);
    }
    return out;
  }, [rings, expanded, graph]);
  const openFinding = (id: string) => {
    setSelectedFinding(id);
    updatePrefs({ inspector: true, inspectorTab: "details" });
  };

  // Blast radius of the selection (core's pure function, as the API uses).
  const [impactOn, setImpactOn] = useState(false);
  const [impactSettings, setImpactSettings] = useState<ImpactSettings>({
    includeTypeOnly: true,
    maxDepth: undefined,
  });
  useEffect(() => {
    setImpactSettings((s) =>
      s.maxDepth === undefined ? s : { ...s, maxDepth: undefined },
    );
  }, [selected]);
  const impactFull = useMemo(
    () =>
      isFileNode(selected)
        ? blastRadius(graph, selected, {
            mode: "certain",
            includeTypeOnly: impactSettings.includeTypeOnly,
          })
        : undefined,
    [graph, isFileNode, selected, impactSettings.includeTypeOnly],
  );
  const impact = useMemo(() => {
    const max = impactSettings.maxDepth;
    if (!impactFull || max === undefined || max >= impactFull.maxDepth) {
      return impactFull;
    }
    return blastRadius(graph, impactFull.nodeId, {
      mode: "certain",
      includeTypeOnly: impactSettings.includeTypeOnly,
      maxDepth: max,
    });
  }, [graph, impactFull, impactSettings]);
  /** Drawn node -> distance from the selection (folders: their nearest file). */
  const visibleImpact = useMemo(() => {
    if (!impactOn || !impact) return undefined;
    const depth = new Map<string, number>();
    const put = (id: string, d: number) => {
      const rep = representative(id, expanded, graph);
      depth.set(rep, Math.min(depth.get(rep) ?? d, d));
    };
    for (const a of impact.affected) put(a.id, a.depth);
    put(impact.nodeId, 0);
    return depth;
  }, [impactOn, impact, expanded, graph]);
  const toggleImpact = () => {
    setImpactOn((on) => {
      if (!on) updatePrefs({ inspector: true, inspectorTab: "impact" });
      return !on;
    });
  };

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
    setExpanded((e) => expandTo(e, id, graph));
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
    () => new Set(graph.nodes.flatMap((n) => ancestors(n.id, graph))),
    [graph],
  );
  const canFocus = center !== undefined || isFileNode(selected);
  const controls = () =>
    view === "focus"
      ? focusControls.current
      : mode3d
        ? graph3dControls.current
        : graphControls.current;

  const runners: Record<CommandId, () => void> = {
    palette: () => {
      setPalette((p) => !p);
    },
    "project.open": () => onOpenAnother?.(),
    "view.graph": () => {
      setView("graph");
      if (selected !== undefined) {
        setExpanded((e) => expandTo(e, selected, graph));
        setReveal({ id: selected });
      }
    },
    "view.focus": () => {
      if (isFileNode(selected) && selected !== center) focusOn(selected);
      else if (center !== undefined) setView("focus");
    },
    "view.findings": () => {
      setView("findings");
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
    "graph.dimensions": () => {
      updatePrefs({ graphMode: mode3d ? "2d" : "3d" });
      setView("graph");
    },
    "graph.colorBy": () => {
      updatePrefs({ colorBy: NEXT_COLOR_BY[prefs.colorBy] });
    },
    "graph.blastRadius": () => {
      toggleImpact();
    },
    "graph.findingsOnly": () => {
      setFindingsOnly((on) => !on);
      setView("graph");
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
      id: "view.findings",
      title: "Show Findings",
      enabled: view !== "findings",
    },
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
      id: "graph.dimensions",
      title: mode3d ? "Show 2D Graph" : "Show 3D Graph",
      enabled: webgl,
    },
    {
      id: "graph.colorBy",
      title: `Color by ${COLOR_BY_NAMES[NEXT_COLOR_BY[prefs.colorBy]]}`,
      enabled: true,
    },
    {
      id: "graph.blastRadius",
      title: impactOn ? "Hide Blast Radius" : "Show Blast Radius",
      enabled: impactOn || isFileNode(selected),
    },
    {
      id: "graph.findingsOnly",
      title: findingsOnly ? "Show All Files" : "Show Only Files with Findings",
      enabled: !mode3d,
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
                setExpanded((e) => expandTo(e, id, graph));
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
              run(VIEW_COMMANDS[v], "key");
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
              { value: "findings", label: "Findings", icon: Lightbulb },
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
              findingsCount={summary.total}
              onView={(v) => {
                run(VIEW_COMMANDS[v], "key");
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
          <div className={view === "graph" && !mode3d ? "h-full" : "hidden"}>
            <GraphView
              active={view === "graph" && !mode3d}
              visible={visible}
              colors={colors}
              selected={selected}
              impact={visibleImpact}
              findingRings={visibleRings}
              findingsOnly={findingsOnly}
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
          {mode3d && data3d !== undefined && (
            <div className={view === "graph" ? "h-full" : "hidden"}>
              <Suspense
                fallback={
                  <p className="text-muted pt-[30vh] text-center">
                    Loading the 3D view…
                  </p>
                }
              >
                <Graph3DView
                  active={view === "graph"}
                  data={data3d}
                  colors={colors}
                  selected={selected}
                  reveal={reveal}
                  onSelect={setSelected}
                  onActivate={focusOn}
                  controlsRef={graph3dControls}
                />
              </Suspense>
            </div>
          )}
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
          {view === "findings" && (
            <div className="h-full">
              <FindingsView
                graph={graph}
                analysis={analysis ?? null}
                state={findings}
                selected={selectedFinding}
                onSelect={openFinding}
              />
            </div>
          )}
          {view !== "findings" &&
            findings.ready &&
            summary.total > 0 &&
            bannerClosedAt !== summary.total && (
              <FindingsBanner
                summary={summary}
                onReview={() => {
                  setView("findings");
                }}
                onClose={() => {
                  setBannerClosedAt(summary.total);
                }}
              />
            )}
          {view === "graph" && !mode3d && visibleImpact && (
            <div
              data-testid="impact-legend"
              className="bg-raised/90 border-line text-muted pointer-events-none absolute top-3 left-3 flex items-center gap-3 rounded-lg border px-2.5 py-1.5 text-[11px] backdrop-blur"
            >
              <span className="text-fg font-medium">Blast radius</span>
              {[
                ["border-accent", "Changed"],
                ["border-danger", "Direct"],
                ["border-dependents", "2 away"],
                ["border-dependents/60", "3+ away"],
              ].map(([ring, label]) => (
                <span key={label} className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={`size-2.5 rounded-full border-2 ${ring ?? ""}`}
                  />
                  {label}
                </span>
              ))}
            </div>
          )}
          {watch?.state === "stopped" && !watchNoticeClosed && (
            <div
              role="status"
              className="bg-raised border-line shadow-pop absolute top-3 right-3 flex max-w-sm items-start gap-2 rounded-lg border px-3 py-2 text-[12px]"
            >
              <p className="selectable">{watch.message}</p>
              <button
                type="button"
                className="text-muted hover:text-fg shrink-0"
                aria-label="Dismiss"
                onClick={() => {
                  setWatchNoticeClosed(true);
                }}
              >
                ×
              </button>
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
          {view !== "findings" && (
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
              dimensions={mode3d ? "3d" : "2d"}
              onDimensions={(d) => {
                updatePrefs({ graphMode: d });
              }}
              webgl={webgl}
              impact={impactOn}
              impactEnabled={impactOn || isFileNode(selected)}
              onImpact={toggleImpact}
              findingsOnly={findingsOnly}
              onFindingsOnly={setFindingsOnly}
            />
          )}
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
                view === "findings" && finding !== undefined ? (
                  <FindingDetails
                    key={finding.id}
                    api={api}
                    graph={graph}
                    finding={finding}
                    state={findings}
                    onShow={show}
                    previews={shell !== undefined}
                  />
                ) : (
                  <DetailsPanel
                    graph={graph}
                    analysis={analysis ?? null}
                    selected={selected}
                    onShow={show}
                    onFocus={focusOn}
                    folderOpen={
                      selected !== undefined && expanded.has(dirPath(selected))
                    }
                    onToggleFolder={toggleDir}
                  />
                )
              }
              impact={
                <ImpactPanel
                  selected={isFileNode(selected) ? selected : undefined}
                  full={impactFull}
                  result={impact}
                  settings={impactSettings}
                  onSettings={setImpactSettings}
                  shown={impactOn}
                  onShown={(on) => {
                    if (on !== impactOn) toggleImpact();
                  }}
                  onShow={show}
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

      <StatusBar
        graph={graph}
        watch={watch}
        analysis={analysis ?? null}
        updatedAt={updatedAt}
      />

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
