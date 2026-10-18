import { Clock, FolderOpen, Network, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectInfo } from "@epoch-dev/core";
import type { Shell } from "../api";
import { Button, Kbd } from "../components/ui";
import { isMac } from "../platform";
import { SHORTCUTS } from "./commands";
import { shortcutLabel } from "./shortcuts";

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

export interface WelcomeProps {
  readonly shell: Shell;
  readonly onOpen: (start: () => Promise<ProjectInfo | null>) => void;
  readonly openRecent: (folder: string) => void;
  readonly error: string | undefined;
}

/** Open a folder: the native dialog, drag-and-drop, or a recent project. */
export function Welcome({ shell, onOpen, openRecent, error }: WelcomeProps) {
  const [recent, setRecent] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(readDismissed);
  const shortcut = SHORTCUTS["project.open"];

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
    <main className="flex min-h-0 flex-1 justify-center overflow-auto">
      <div className="flex w-full max-w-[520px] flex-col gap-7 px-8 py-[10vh]">
        <header className="flex items-center gap-3">
          <span className="bg-accent text-on-accent flex size-11 items-center justify-center rounded-xl shadow-sm">
            <Network size={24} strokeWidth={1.75} aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-[22px] leading-tight font-semibold">Epoch</h1>
            <p className="text-muted text-[13px]">
              Open a project folder to see how its files depend on each other.
            </p>
          </div>
        </header>

        <div className="flex flex-col gap-2">
          <Button
            variant="primary"
            icon={FolderOpen}
            className="h-9 justify-center px-4 text-[14px]"
            onClick={() => {
              onOpen(() => shell.chooseProject());
            }}
          >
            Open Project…
          </Button>
          <p className="text-muted flex items-center justify-center gap-2 text-xs">
            {shortcut && <Kbd>{shortcutLabel(shortcut, isMac())}</Kbd>}
            or drop a folder anywhere on this window
          </p>
        </div>

        {error !== undefined && (
          <p
            role="alert"
            className="border-danger/30 bg-danger/10 text-danger rounded-lg border px-3 py-2 text-[13px]"
          >
            {error}
          </p>
        )}

        {recent.length > 0 && (
          <section>
            <h2 className="text-muted mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase">
              <Clock size={12} aria-hidden="true" />
              Recent projects
            </h2>
            <ul className="border-line bg-raised divide-line divide-y overflow-hidden rounded-lg border">
              {recent.map((folder) => (
                <li key={folder}>
                  <button
                    type="button"
                    className="hover:bg-hover flex w-full items-center gap-3 px-3 py-2 text-left"
                    onClick={() => {
                      openRecent(folder);
                    }}
                  >
                    <FolderOpen
                      size={16}
                      aria-hidden="true"
                      className="text-muted shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">
                        {basename(folder)}
                      </span>
                      <span className="text-muted block truncate text-[11px]">
                        {folder}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!dismissed && (
          <aside
            className="border-line bg-chrome flex gap-3 rounded-lg border p-3 text-[13px]"
            aria-label="Privacy"
          >
            <ShieldCheck
              size={18}
              aria-hidden="true"
              className="text-imports mt-0.5 shrink-0"
            />
            <div>
              <p>
                Your code stays on this computer. Epoch reads the folder you
                open, never changes it, and never runs its code. There is no
                account and no telemetry. Features that use AI models are off
                until you turn them on with your own key. Once a day Epoch asks
                GitHub whether a newer version is out; Settings can turn that
                off.
              </p>
              <Button
                variant="ghost"
                className="text-accent! -ml-2.5 mt-1"
                onClick={() => {
                  writeDismissed();
                  setDismissed(true);
                }}
              >
                Got it
              </Button>
            </div>
          </aside>
        )}
      </div>
    </main>
  );
}
