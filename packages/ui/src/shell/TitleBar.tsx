import { Menu, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { cx, IconButton } from "../components/ui";
import { isMac } from "../platform";

/**
 * The window's own title bar: a drag region that holds the app's controls.
 * macOS draws the traffic lights at its left (titleBarStyle "hiddenInset");
 * Windows and Linux draw their window buttons over its right end (Window
 * Controls Overlay) and get a menu button, since there is no menu bar.
 */
export function TitleBar(props: {
  /** In the desktop app (not the static demo): leave room for window buttons. */
  readonly desktop: boolean;
  readonly onAppMenu?: ((x: number, y: number) => void) | undefined;
  /** Shows a Settings button at the end (the desktop app). */
  readonly onSettings?: (() => void) | undefined;
  readonly children?: ReactNode;
}) {
  const mac = isMac();
  return (
    <header
      className={cx(
        "titlebar drag bg-chrome border-line flex shrink-0 items-center border-b",
        props.desktop && mac && "mac-inset",
      )}
    >
      <div className="flex h-full min-w-0 flex-1 items-center gap-1 px-2">
        {props.desktop && !mac && props.onAppMenu && (
          <IconButton
            icon={Menu}
            label="Application menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              props.onAppMenu?.(Math.round(r.left), Math.round(r.bottom));
            }}
          />
        )}
        {props.children}
        {props.onSettings && (
          <IconButton
            icon={Settings}
            label="Settings"
            onClick={props.onSettings}
          />
        )}
      </div>
    </header>
  );
}
