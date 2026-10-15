import { CornerDownLeft, FileCode, Search, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cx, Kbd, PathLabel } from "../components/ui";
import { isMac } from "../platform";
import type { Command } from "./commands";
import { fuzzyFilter } from "./fuzzy";
import { shortcutLabel } from "./shortcuts";

interface Item {
  readonly key: string;
  readonly kind: "command" | "file";
  /** The accessible name: a command's title, or a file's path. */
  readonly label: string;
  readonly shortcut?: string;
  readonly run: () => void;
}

const MAX_FILES = 50;
const MAX_COMMANDS = 8;

/**
 * ⌘K / Ctrl+K: find a file or run a command. Arrow keys move, Enter runs,
 * Escape closes.
 */
export function CommandPalette(props: {
  readonly files: readonly string[];
  readonly commands: readonly Command[];
  readonly onOpenFile: (id: string) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const mac = isMac();

  useEffect(() => {
    input.current?.focus();
  }, []);

  const items = useMemo((): Item[] => {
    const enabled = props.commands.filter((c) => c.enabled);
    const commands = (
      query.trim() === ""
        ? enabled
        : fuzzyFilter(enabled, query, (c) => c.title, MAX_COMMANDS)
    ).map((c): Item => ({
      key: `command:${c.id}`,
      kind: "command",
      label: c.title,
      ...(c.shortcut ? { shortcut: shortcutLabel(c.shortcut, mac) } : {}),
      run: c.run,
    }));
    const files =
      query.trim() === ""
        ? []
        : fuzzyFilter(props.files, query, (f) => f, MAX_FILES).map(
            (f): Item => ({
              key: `file:${f}`,
              kind: "file",
              label: f,
              run: () => {
                props.onOpenFile(f);
              },
            }),
          );
    // Files first once there is a query: finding a file is the common case.
    return query.trim() === "" ? commands : [...files, ...commands];
  }, [props.files, props.commands, props.onOpenFile, query, mac]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${String(active)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (item: Item | undefined) => {
    if (!item) return;
    props.onClose();
    item.run();
  };

  const fileCount = items.filter((i) => i.kind === "file").length;

  return (
    <div
      className="no-drag fixed inset-0 z-40 flex justify-center bg-black/15 pt-[12vh] dark:bg-black/40"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Command palette"
        className="border-line bg-raised shadow-pop flex h-fit max-h-[60vh] w-[min(600px,90vw)] flex-col overflow-hidden rounded-xl border"
      >
        <div className="border-line flex items-center gap-2 border-b px-3">
          <Search size={16} aria-hidden="true" className="text-muted" />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-label="Search files and commands"
            placeholder="Search files and commands…"
            spellCheck={false}
            className="h-11 min-w-0 flex-1 bg-transparent text-[14px] outline-none"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(items.length - 1, a + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(items[active]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                props.onClose();
              }
            }}
          />
          <Kbd>esc</Kbd>
        </div>
        <ul
          ref={listRef}
          id="palette-results"
          role="listbox"
          aria-label="Results"
          className="min-h-0 flex-1 overflow-auto p-1.5"
        >
          {items.length === 0 && (
            <li className="text-muted px-3 py-6 text-center">No matches</li>
          )}
          {items.map((item, i) => (
            <li
              key={item.key}
              role="option"
              aria-selected={i === active}
              aria-label={item.label}
              data-index={i}
              className={cx(
                "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px]",
                i === active && "bg-active",
              )}
              onPointerMove={() => {
                if (i !== active) setActive(i);
              }}
              onClick={() => {
                run(item);
              }}
            >
              {item.kind === "file" ? (
                <FileCode
                  size={15}
                  aria-hidden="true"
                  className="text-muted shrink-0"
                />
              ) : (
                <SquareTerminal
                  size={15}
                  aria-hidden="true"
                  className="text-muted shrink-0"
                />
              )}
              <span className="min-w-0 flex-1 truncate">
                {item.kind === "file" ? (
                  <PathLabel id={item.label} />
                ) : (
                  item.label
                )}
              </span>
              {item.shortcut !== undefined && <Kbd>{item.shortcut}</Kbd>}
              {i === active && (
                <CornerDownLeft
                  size={13}
                  aria-hidden="true"
                  className="text-muted"
                />
              )}
            </li>
          ))}
        </ul>
        <div className="border-line text-faint flex justify-between border-t px-3 py-1.5 text-[11px]">
          <span>
            {query.trim() === ""
              ? "Type to find a file"
              : `${String(fileCount)}${fileCount === MAX_FILES ? "+" : ""} files`}
          </span>
          <span>↑↓ to move · ↵ to open</span>
        </div>
      </div>
    </div>
  );
}
