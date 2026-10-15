import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/* The few controls every screen shares, drawn from the design tokens. */

const cx = (...parts: (string | false | undefined)[]): string =>
  parts.filter(Boolean).join(" ");

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: "primary" | "secondary" | "ghost";
  readonly icon?: LucideIcon;
};

export function Button({
  variant = "secondary",
  icon: Icon,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        "no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors disabled:opacity-40",
        variant === "primary" &&
          "bg-accent text-on-accent hover:brightness-110 active:brightness-95",
        variant === "secondary" &&
          "border-line bg-raised hover:bg-hover border shadow-xs",
        variant === "ghost" && "text-fg hover:bg-hover",
        className,
      )}
      {...rest}
    >
      {Icon && <Icon size={15} strokeWidth={1.75} aria-hidden="true" />}
      {children}
    </button>
  );
}

type IconButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> & {
  readonly icon: LucideIcon;
  /** Accessible name and tooltip. */
  readonly label: string;
  readonly shortcut?: string | undefined;
  readonly active?: boolean;
};

export function IconButton({
  icon: Icon,
  label,
  shortcut,
  active,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={shortcut === undefined ? label : `${label} (${shortcut})`}
      className={cx(
        "no-drag text-muted hover:text-fg hover:bg-hover inline-flex size-7 items-center justify-center rounded-md transition-colors disabled:opacity-30 disabled:hover:bg-transparent",
        active && "bg-active text-fg",
        className,
      )}
      {...rest}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

export interface SegmentedOption<T extends string | number> {
  readonly value: T;
  readonly label: string;
  readonly icon?: LucideIcon;
  readonly title?: string;
  readonly disabled?: boolean;
}

/** A row of mutually exclusive buttons (aria-pressed), like a native segmented control. */
export function Segmented<T extends string | number>(props: {
  readonly label: string;
  readonly options: readonly SegmentedOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly iconOnly?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={props.label}
      className="no-drag bg-sunken inline-flex h-7 items-center rounded-md p-0.5"
    >
      {props.options.map((o) => {
        const Icon = o.icon;
        const on = o.value === props.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            aria-label={props.iconOnly ? o.label : undefined}
            title={o.title ?? (props.iconOnly ? o.label : undefined)}
            disabled={o.disabled}
            onClick={() => {
              props.onChange(o.value);
            }}
            className={cx(
              "inline-flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium transition-colors disabled:opacity-35",
              on ? "bg-raised text-fg shadow-xs" : "text-muted hover:text-fg",
            )}
          >
            {Icon && <Icon size={14} strokeWidth={1.75} aria-hidden="true" />}
            {!props.iconOnly && o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A labeled switch over a real checkbox (so it is a checkbox to assistive tech and tests). */
export function Toggle(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly title?: string;
}) {
  return (
    <label
      className="no-drag text-muted hover:text-fg inline-flex h-7 items-center gap-2 rounded-md px-1.5 text-xs font-medium whitespace-nowrap"
      title={props.title}
    >
      <input
        type="checkbox"
        className="bg-strong-line checked:bg-accent relative h-4 w-7 shrink-0 appearance-none rounded-full transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-3 after:rounded-full after:bg-white after:transition-transform checked:after:translate-x-3"
        checked={props.checked}
        onChange={(e) => {
          props.onChange(e.target.checked);
        }}
      />
      {props.label}
    </label>
  );
}

export function Kbd({ children }: { readonly children: ReactNode }) {
  return (
    <kbd className="border-line bg-sunken text-muted rounded border px-1 font-sans text-[11px] leading-4">
      {children}
    </kbd>
  );
}

export function SectionTitle({
  children,
  right,
}: {
  readonly children: ReactNode;
  readonly right?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-1">
      <h3 className="text-muted text-[11px] font-semibold tracking-wide uppercase">
        {children}
      </h3>
      {right}
    </div>
  );
}

const folderPart = (id: string): string =>
  id.includes("/") ? id.slice(0, id.lastIndexOf("/") + 1) : "";

/** A repository path with its folder muted. Its text is the full path. */
export function PathLabel({
  id,
  className,
}: {
  readonly id: string;
  readonly className?: string;
}) {
  const folder = folderPart(id);
  return (
    <span className={cx("min-w-0 break-all", className)}>
      {folder !== "" && <span className="text-muted">{folder}</span>}
      <span>{id.slice(folder.length)}</span>
    </span>
  );
}

export { cx };
