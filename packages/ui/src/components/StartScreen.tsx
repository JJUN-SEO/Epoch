import { useEffect, useState } from "react";
import type { ProjectInfo } from "@epoch-dev/core";
import type { Shell } from "../api";

const FIRST_RUN_KEY = "epoch.firstRunNoteDismissed";

/** localStorage can be missing or throw; the note then simply shows again. */
function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(FIRST_RUN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(FIRST_RUN_KEY, "1");
  } catch {
    // not persisted; harmless
  }
}

const basename = (p: string): string =>
  p
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) ?? p;

export interface StartScreenProps {
  readonly shell: Shell;
  readonly onOpen: (start: () => Promise<ProjectInfo | null>) => void;
  readonly openRecent: (folder: string) => void;
  readonly error: string | undefined;
}

/** Open a folder: the native dialog, drag-and-drop, or a recent project. */
export function StartScreen({
  shell,
  onOpen,
  openRecent,
  error,
}: StartScreenProps) {
  const [recent, setRecent] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    let live = true;
    shell.recentProjects().then(
      (list) => {
        if (live) setRecent(list);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [shell]);

  return (
    <main className="mx-auto flex h-full max-w-xl flex-col justify-center gap-6 p-8">
      <header>
        <h1 className="text-3xl font-semibold">Epoch</h1>
        <p className="mt-1 text-neutral-600 dark:text-neutral-400">
          Open a project folder to see how its files depend on each other.
        </p>
      </header>

      {!dismissed && (
        <aside
          className="rounded-lg border border-neutral-300 p-4 text-sm dark:border-neutral-700"
          aria-label="Privacy"
        >
          <p>
            Your code stays on this computer. Epoch reads the folder you open,
            never changes it, and never runs its code. There is no account and
            no telemetry. Features that use AI models are off until you turn
            them on with your own key.
          </p>
          <button
            type="button"
            className="mt-2 text-blue-700 hover:underline dark:text-blue-300"
            onClick={() => {
              writeDismissed();
              setDismissed(true);
            }}
          >
            Got it
          </button>
        </aside>
      )}

      <div className="flex items-center gap-4">
        <button
          type="button"
          className="rounded-md bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
          onClick={() => {
            onOpen(() => shell.chooseProject());
          }}
        >
          Open Project…
        </button>
        <span className="text-sm text-neutral-500">
          or drop a folder anywhere on this window
        </span>
      </div>

      {error !== undefined && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      {recent.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
            Recent projects
          </h2>
          <ul className="mt-2 space-y-1">
            {recent.map((folder) => (
              <li key={folder}>
                <button
                  type="button"
                  className="w-full rounded px-2 py-1 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  onClick={() => {
                    openRecent(folder);
                  }}
                >
                  <span className="font-medium">{basename(folder)}</span>
                  <span className="ml-2 text-xs break-all text-neutral-500">
                    {folder}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
