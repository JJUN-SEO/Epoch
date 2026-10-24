import { useEffect, useRef, type ReactNode } from "react";

/**
 * A floating panel that closes on Escape or a click outside it. Used for
 * menus, the project switcher and the coverage panel ("dialog").
 */
export function Popover(props: {
  readonly onClose: () => void;
  readonly className?: string;
  readonly label: string;
  readonly role?: "menu" | "dialog";
  readonly children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) {
        close.current();
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    const blur = () => {
      close.current();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", blur);
    };
  }, []);
  return (
    <div
      ref={panel}
      role={props.role ?? "menu"}
      aria-label={props.label}
      className={`no-drag border-line bg-raised shadow-pop absolute z-30 rounded-lg border p-1 ${props.className ?? ""}`}
    >
      {props.children}
    </div>
  );
}

export function MenuItem(props: {
  readonly onSelect: () => void;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={props.disabled}
      title={props.title}
      className="hover:bg-accent hover:text-on-accent flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-inherit"
      onClick={props.onSelect}
    >
      {props.children}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="bg-line mx-1 my-1 h-px" />;
}
