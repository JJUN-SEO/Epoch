import { useEffect, useState } from "react";
import { CircleArrowUp } from "lucide-react";
import type { Shell } from "../api";
import type { AvailableUpdate } from "../bridge";

/**
 * A newer Epoch is out (the daily update check, ADR-018): a small,
 * non-blocking note with a link to the release page, which opens in the
 * browser. Epoch downloads and installs nothing; hiding the note lasts until
 * the app restarts.
 */
export function UpdateNotice({ shell }: { readonly shell: Shell }) {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let live = true;
    shell.getUpdateStatus().then(
      (u) => {
        if (live && u) setUpdate(u);
      },
      () => undefined,
    );
    const off = shell.onUpdateAvailable(setUpdate);
    return () => {
      live = false;
      off();
    };
  }, [shell]);
  if (!update || hidden) return null;
  return (
    <div
      role="status"
      data-testid="update-notice"
      className="bg-raised/95 border-line shadow-pop fixed right-3 bottom-10 z-30 flex max-w-[min(420px,calc(100%-24px))] items-center gap-2.5 rounded-lg border py-1.5 pr-1.5 pl-3 text-[12px] backdrop-blur"
    >
      <CircleArrowUp
        size={15}
        strokeWidth={1.75}
        aria-hidden="true"
        className="text-accent shrink-0"
      />
      <p className="min-w-0 flex-1">
        <span className="font-medium">
          Epoch {update.latest.replace(/^v/, "")} is available
        </span>
        <span className="text-muted"> (you have {update.current})</span>
      </p>
      <a
        href={update.url}
        target="_blank"
        rel="noreferrer"
        className="text-accent hover:bg-hover rounded-md px-2 py-1 font-medium"
      >
        See the release
      </a>
      <button
        type="button"
        className="text-muted hover:text-fg hover:bg-hover inline-flex size-6 shrink-0 items-center justify-center rounded-md"
        aria-label="Hide until Epoch restarts"
        title="Hide until Epoch restarts"
        onClick={() => {
          setHidden(true);
        }}
      >
        ×
      </button>
    </div>
  );
}
