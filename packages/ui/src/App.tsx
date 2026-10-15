import { useCallback, useEffect, useRef, useState } from "react";
import type { EpochApi, Graph, Progress, ProjectInfo } from "@epoch-dev/core";
import type { Shell } from "./api";
import { errorMessage } from "./errors";
import { ProgressPane } from "./shell/ProgressPane";
import { TitleBar } from "./shell/TitleBar";
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
  /** Only the newest open request may update the view. */
  const generation = useRef(0);

  useEffect(() => api.onProgress(setProgress), [api]);

  /** Runs `start` (which opens a project in main), then waits for its graph. */
  const open = useCallback(
    (start: () => Promise<ProjectInfo | null>) => {
      const mine = ++generation.current;
      setProgress(undefined);
      void (async () => {
        try {
          const project = await start();
          if (project === null || mine !== generation.current) return;
          setView({ kind: "analyzing", project });
          const graph = await api.getGraph();
          if (mine === generation.current) {
            setView({ kind: "graph", project, graph });
          }
        } catch (error) {
          if (mine === generation.current) {
            setView({ kind: "start", error: errorMessage(error) });
          }
        }
      })();
    },
    [api],
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
        </div>
      );
    case "analyzing":
      return (
        <div className="flex h-full flex-col">
          {titleBar(view.project.name)}
          <ProgressPane project={view.project} progress={progress} />
        </div>
      );
    case "graph":
      return (
        <Workspace
          key={view.project.root}
          project={view.project}
          graph={view.graph}
          {...(shell
            ? {
                shell,
                onOpenAnother: () => {
                  open(() => shell.chooseProject());
                },
                onOpenRecent: (folder: string) => {
                  open(() => api.openProject(folder));
                },
              }
            : {})}
        />
      );
  }
}
