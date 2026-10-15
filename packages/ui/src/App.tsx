import { useCallback, useEffect, useRef, useState } from "react";
import type { EpochApi, Graph, Progress, ProjectInfo } from "@epoch-dev/core";
import type { Shell } from "./api";
import { GraphScreen } from "./components/GraphScreen";
import { ProgressView } from "./components/ProgressView";
import { StartScreen } from "./components/StartScreen";
import { errorMessage } from "./errors";

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

/** Start screen -> streaming progress -> graph (CLAUDE.md "App UX basics"). */
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

  switch (view.kind) {
    case "start":
      return shell ? (
        <StartScreen
          shell={shell}
          error={view.error}
          onOpen={open}
          openRecent={(folder) => {
            open(() => api.openProject(folder));
          }}
        />
      ) : (
        <main className="p-8">This page needs the Epoch desktop app.</main>
      );
    case "analyzing":
      return <ProgressView project={view.project} progress={progress} />;
    case "graph":
      return (
        <GraphScreen
          key={view.project.root}
          project={view.project}
          graph={view.graph}
          {...(shell
            ? {
                onOpenAnother: () => {
                  open(() => shell.chooseProject());
                },
              }
            : {})}
        />
      );
  }
}
