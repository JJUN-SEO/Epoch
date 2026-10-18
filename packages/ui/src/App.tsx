import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyDelta,
  type AnalysisInfo,
  type EpochApi,
  type Graph,
  type Progress,
  type ProjectInfo,
  type WatchStatus,
} from "@epoch-dev/core";
import type { Shell } from "./api";
import { errorMessage } from "./errors";
import { isMac } from "./platform";
import { SettingsDialog } from "./settings/SettingsDialog";
import { SHORTCUTS } from "./shell/commands";
import { ProgressPane } from "./shell/ProgressPane";
import { matches } from "./shell/shortcuts";
import { TitleBar } from "./shell/TitleBar";
import { UpdateNotice } from "./shell/UpdateNotice";
import { Welcome } from "./shell/Welcome";
import { Workspace } from "./shell/Workspace";

type View =
  | { readonly kind: "start"; readonly error?: string }
  | { readonly kind: "analyzing"; readonly project: ProjectInfo }
  | {
      readonly kind: "graph";
      readonly project: ProjectInfo;
      readonly graph: Graph;
    };

export interface AppProps {
  readonly api: EpochApi;
  /** The desktop app's folder access; absent in the static demo. */
  readonly shell?: Shell;
}

/** Welcome -> streaming progress -> the project workspace (CLAUDE.md "App UX basics"). */
export function App({ api, shell }: AppProps) {
  const [view, setView] = useState<View>({ kind: "start" });
  const [progress, setProgress] = useState<Progress | undefined>();
  const [watch, setWatch] = useState<WatchStatus | undefined>();
  const [analysis, setAnalysis] = useState<AnalysisInfo | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Only the newest open request may update the view. */
  const generation = useRef(0);

  // Settings opens from the native menu or its shortcut, on any screen.
  useEffect(
    () =>
      shell?.onMenuCommand((id) => {
        if (id === "settings") setSettingsOpen(true);
      }),
    [shell],
  );
  useEffect(() => {
    const shortcut = SHORTCUTS.settings;
    if (!shell || !shortcut) return;
    const mac = isMac();
    const onKey = (e: KeyboardEvent) => {
      if (matches(e, shortcut, mac)) {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [shell]);
  const openSettings = shell
    ? () => {
        setSettingsOpen(true);
      }
    : undefined;
  // A newer release, on every screen of the desktop app (ADR-018).
  const updateNotice = shell ? <UpdateNotice shell={shell} /> : null;
  const settingsDialog =
    settingsOpen && shell ? (
      <SettingsDialog
        api={api}
        shell={shell}
        onClose={() => {
          setSettingsOpen(false);
        }}
      />
    ) : null;

  useEffect(() => api.onProgress(setProgress), [api]);
  // Watcher updates, already applied in main; applying one twice changes nothing.
  useEffect(
    () =>
      api.onGraphDelta((d) => {
        setView((v) =>
          v.kind === "graph" ? { ...v, graph: applyDelta(v.graph, d) } : v,
        );
        setUpdatedAt(new Date());
      }),
    [api],
  );
  useEffect(() => shell?.onWatchStatus(setWatch), [shell]);
  useEffect(() => shell?.onAnalysisInfo(setAnalysis), [shell]);

  /** Runs `start` (which opens a project in main), then waits for its graph. */
  const open = useCallback(
    (start: () => Promise<ProjectInfo | null>) => {
      const mine = ++generation.current;
      setProgress(undefined);
      setWatch(undefined);
      setAnalysis(null);
      setUpdatedAt(undefined);
      void (async () => {
        try {
          const project = await start();
          if (project === null || mine !== generation.current) return;
          setView({ kind: "analyzing", project });
          const graph = await api.getGraph();
          const info = (await shell?.getAnalysisInfo()) ?? null;
          if (mine === generation.current) {
            setView({ kind: "graph", project, graph });
            setAnalysis((a) => a ?? info);
          }
        } catch (error) {
          if (mine === generation.current) {
            setView({ kind: "start", error: errorMessage(error) });
          }
        }
      })();
    },
    [api, shell],
  );

  // Projects opened from the native menu.
  useEffect(
    () =>
      shell?.onProjectOpened((project) => {
        open(() => Promise.resolve(project));
      }),
    [shell, open],
  );

  // Drop a folder anywhere on the window.
  useEffect(() => {
    if (!shell) return;
    const over = (e: DragEvent) => {
      e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (file) open(() => shell.openDroppedFolder(file));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [shell, open]);

  const titleBar = (title?: string) => (
    <TitleBar
      desktop={shell !== undefined}
      onAppMenu={
        shell
          ? (x, y) => {
              shell.showAppMenu(x, y);
            }
          : undefined
      }
      onSettings={openSettings}
    >
      <span className="text-muted flex-1 truncate text-center text-[13px] font-medium">
        {title ?? "Epoch"}
      </span>
    </TitleBar>
  );

  switch (view.kind) {
    case "start":
      return (
        <div className="flex h-full flex-col">
          {titleBar()}
          {shell ? (
            <Welcome
              shell={shell}
              error={view.error}
              onOpen={open}
              openRecent={(folder) => {
                open(() => api.openProject(folder));
              }}
            />
          ) : (
            <main className="p-8">This page needs the Epoch desktop app.</main>
          )}
          {updateNotice}
          {settingsDialog}
        </div>
      );
    case "analyzing":
      return (
        <div className="flex h-full flex-col">
          {titleBar(view.project.name)}
          <ProgressPane project={view.project} progress={progress} />
          {updateNotice}
          {settingsDialog}
        </div>
      );
    case "graph":
      return (
        <>
          <Workspace
            key={view.project.root}
            api={api}
            project={view.project}
            graph={view.graph}
            watch={watch}
            analysis={analysis}
            updatedAt={updatedAt}
            {...(shell
              ? {
                  shell,
                  onOpenAnother: () => {
                    open(() => shell.chooseProject());
                  },
                  onOpenRecent: (folder: string) => {
                    open(() => api.openProject(folder));
                  },
                  onOpenSettings: () => {
                    setSettingsOpen(true);
                  },
                }
              : {})}
          />
          {updateNotice}
          {settingsDialog}
        </>
      );
  }
}
