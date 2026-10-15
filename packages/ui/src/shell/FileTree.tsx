import { ChevronRight, FileCode, Folder, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Graph } from "@epoch-dev/core";
import {
  ancestors,
  dirId,
  dirPath,
  initialExpanded,
  isDirId,
} from "../graph/aggregate";
import { cx } from "../components/ui";

interface TreeFolder {
  readonly path: string;
  readonly name: string;
  readonly folders: TreeFolder[];
  readonly files: string[];
  count: number;
}

/** The project's folders and files, from the graph's node ids. */
export function buildTree(graph: Graph): TreeFolder {
  const root: TreeFolder = {
    path: "",
    name: "",
    folders: [],
    files: [],
    count: 0,
  };
  const folders = new Map<string, TreeFolder>([["", root]]);
  const folderAt = (path: string): TreeFolder => {
    const existing = folders.get(path);
    if (existing) return existing;
    const parentPath = path.includes("/")
      ? path.slice(0, path.lastIndexOf("/"))
      : "";
    const folder: TreeFolder = {
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      folders: [],
      files: [],
      count: 0,
    };
    folderAt(parentPath).folders.push(folder);
    folders.set(path, folder);
    return folder;
  };
  for (const n of graph.nodes) {
    const dirs = ancestors(n.id);
    const parent = folderAt(dirs.at(-1) ?? "");
    parent.files.push(n.id);
    root.count++;
    for (const d of dirs) folderAt(d).count++;
  }
  const sort = (f: TreeFolder) => {
    f.folders.sort((a, b) => (a.name < b.name ? -1 : 1));
    f.files.sort();
    f.folders.forEach(sort);
  };
  sort(root);
  return root;
}

const fileName = (id: string): string =>
  id.startsWith("pkg:") ? id : id.slice(id.lastIndexOf("/") + 1);

export function FileTree(props: {
  readonly graph: Graph;
  readonly selected: string | undefined;
  readonly onSelect: (id: string) => void;
  readonly onActivate: (id: string) => void;
}) {
  const tree = useMemo(() => buildTree(props.graph), [props.graph]);
  // The same folders the graph opens with.
  const [open, setOpen] = useState<ReadonlySet<string>>(() =>
    initialExpanded(props.graph),
  );
  const list = useRef<HTMLDivElement>(null);

  // Reveal the selection: open the folders above it and scroll it into view.
  useEffect(() => {
    const id = props.selected;
    if (id === undefined) return;
    const path = isDirId(id) ? dirPath(id) : id;
    const above = ancestors(path);
    setOpen((o) =>
      above.every((a) => o.has(a)) ? o : new Set([...o, ...above]),
    );
    requestAnimationFrame(() => {
      const row = list.current?.querySelector(
        `[data-tree-id="${CSS.escape(id)}"]`,
      );
      row?.scrollIntoView({ block: "nearest" });
    });
  }, [props.selected]);

  const toggle = (path: string) => {
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const rows: React.ReactNode[] = [];
  const walk = (folder: TreeFolder, depth: number) => {
    for (const f of folder.folders) {
      const id = dirId(f.path);
      const isOpen = open.has(f.path);
      rows.push(
        <button
          key={id}
          type="button"
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={isOpen}
          aria-selected={props.selected === id}
          data-tree-id={id}
          className={cx(
            "hover:bg-hover flex h-6 w-full items-center gap-1 rounded-md pr-2 text-left",
            props.selected === id && "bg-active",
          )}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() => {
            toggle(f.path);
            props.onSelect(id);
          }}
        >
          <ChevronRight
            size={12}
            aria-hidden="true"
            className={cx(
              "text-faint shrink-0 transition-transform",
              isOpen && "rotate-90",
            )}
          />
          {isOpen ? (
            <FolderOpen
              size={14}
              aria-hidden="true"
              className="text-muted shrink-0"
            />
          ) : (
            <Folder
              size={14}
              aria-hidden="true"
              className="text-muted shrink-0"
            />
          )}
          <span className="min-w-0 flex-1 truncate">{f.name}</span>
          <span className="text-faint text-[11px] tabular-nums">{f.count}</span>
        </button>,
      );
      if (isOpen) walk(f, depth + 1);
    }
    for (const id of folder.files) {
      rows.push(
        <button
          key={id}
          type="button"
          role="treeitem"
          aria-level={depth + 1}
          aria-selected={props.selected === id}
          data-tree-id={id}
          title={id}
          className={cx(
            "hover:bg-hover flex h-6 w-full items-center gap-1 rounded-md pr-2 text-left",
            props.selected === id && "bg-active",
          )}
          style={{ paddingLeft: 6 + depth * 12 + 13 }}
          onClick={() => {
            props.onSelect(id);
          }}
          onDoubleClick={() => {
            props.onActivate(id);
          }}
        >
          <FileCode
            size={14}
            aria-hidden="true"
            className="text-faint shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">{fileName(id)}</span>
        </button>,
      );
    }
  };
  walk(tree, 0);

  return (
    <div
      ref={list}
      role="tree"
      aria-label="Files"
      className="px-1.5 pb-2 text-[13px]"
    >
      {rows}
    </div>
  );
}
