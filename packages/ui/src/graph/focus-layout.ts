import type { EdgeKind } from "@epoch-dev/core";
import { basename } from "./aggregate";
import type { Neighborhood } from "./neighborhood";

/*
 * Positions for the focus view: the center file in the middle, what it
 * imports in columns to the right, what imports it in columns to the left,
 * one column per hop. Computed here rather than by a force layout, so it is
 * instant, stable, and unit-tested.
 */

export const FOCUS_COLUMN_GAP = 280;
export const FOCUS_ROW_GAP = 34;
/** Above this many files, a column groups them by folder (tuned by eye on vitest and Flask). */
export const MAX_PER_COLUMN = 40;

export type FocusSide = "center" | "imports" | "dependents";

export interface FocusNode {
  /** A graph node id, or groupId(...) for a folder group. */
  readonly id: string;
  readonly kind: "center" | "file" | "group";
  /** File name, or the group's folder. */
  readonly label: string;
  /** The file's folder ("" at the root), or the group's file count. */
  readonly detail: string;
  readonly side: FocusSide;
  readonly depth: number;
  /** A file on the imports side that also imports the center. */
  readonly cycle: boolean;
  /** Graph node ids drawn by this node. */
  readonly members: readonly string[];
  readonly position: { readonly x: number; readonly y: number };
}

export interface FocusEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kinds: readonly EdgeKind[];
  readonly hint: boolean;
  readonly outward: boolean;
  /** Neighborhood edges merged into this one (more than one when it touches a group). */
  readonly count: number;
}

export interface FocusLayout {
  readonly nodes: readonly FocusNode[];
  readonly edges: readonly FocusEdge[];
}

export interface FocusLayoutOptions {
  readonly maxPerColumn: number;
  /** Group ids whose files are listed one by one. */
  readonly expandedGroups: ReadonlySet<string>;
}

export const groupId = (
  side: "imports" | "dependents",
  depth: number,
  folder: string,
): string => `group:${side}:${String(depth)}:${folder}`;

export const isGroupId = (id: string): boolean => id.startsWith("group:");

const folderOf = (id: string): string =>
  id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";

/** The first `level` segments of the file's folder. */
const folderAt = (id: string, level: number): string =>
  folderOf(id).split("/").slice(0, level).join("/");

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Entry {
  readonly key: string;
  readonly id: string;
  readonly group?: { readonly folder: string; readonly members: string[] };
}

/** A column's entries: files, or folder groups once there are too many files. */
function columnEntries(
  side: "imports" | "dependents",
  depth: number,
  files: readonly string[],
  options: FocusLayoutOptions,
): Entry[] {
  const single = (id: string): Entry => ({ key: id, id });
  if (files.length <= options.maxPerColumn) return files.map(single);

  const byFolder = (level: number) => {
    const groups = new Map<string, string[]>();
    for (const f of files) {
      const folder = folderAt(f, level);
      const list = groups.get(folder);
      if (list) list.push(f);
      else groups.set(folder, [f]);
    }
    return groups;
  };
  let level = Math.max(
    ...files.map((f) =>
      folderOf(f) === "" ? 0 : folderOf(f).split("/").length,
    ),
  );
  let groups = byFolder(level);
  while (groups.size > options.maxPerColumn && level > 0) {
    level--;
    groups = byFolder(level);
  }

  const entries: Entry[] = [];
  for (const [folder, members] of groups) {
    const id = groupId(side, depth, folder);
    if (members.length === 1 || options.expandedGroups.has(id)) {
      entries.push(...members.map(single));
    } else {
      entries.push({
        key: folder === "" ? "" : `${folder}/`,
        id,
        group: { folder, members },
      });
    }
  }
  return entries.sort((a, b) => compare(a.key, b.key));
}

export function focusLayout(
  hood: Neighborhood,
  options: FocusLayoutOptions,
): FocusLayout {
  const columns = new Map<
    string,
    { side: "imports" | "dependents"; depth: number; files: string[] }
  >();
  const cycles = new Set<string>();
  for (const n of hood.neighbors) {
    const side = n.importDepth === undefined ? "dependents" : "imports";
    const depth = n.importDepth ?? n.dependentDepth ?? 0;
    if (n.importDepth !== undefined && n.dependentDepth !== undefined) {
      cycles.add(n.id);
    }
    const key = `${side}:${String(depth)}`;
    const column = columns.get(key);
    if (column) column.files.push(n.id);
    else columns.set(key, { side, depth, files: [n.id] });
  }

  const nodes: FocusNode[] = [
    {
      id: hood.center,
      kind: "center",
      label: basename(hood.center),
      detail: folderOf(hood.center),
      side: "center",
      depth: 0,
      cycle: false,
      members: [hood.center],
      position: { x: 0, y: 0 },
    },
  ];
  const drawnAs = new Map<string, string>([[hood.center, hood.center]]);
  for (const { side, depth, files } of columns.values()) {
    const entries = columnEntries(side, depth, [...files].sort(), options);
    const x = (side === "imports" ? 1 : -1) * depth * FOCUS_COLUMN_GAP;
    for (const [i, e] of entries.entries()) {
      const position = { x, y: (i - (entries.length - 1) / 2) * FOCUS_ROW_GAP };
      if (e.group) {
        for (const m of e.group.members) drawnAs.set(m, e.id);
        nodes.push({
          id: e.id,
          kind: "group",
          label: e.group.folder === "" ? "." : e.group.folder,
          detail: `${String(e.group.members.length)} files`,
          side,
          depth,
          cycle: false,
          members: e.group.members,
          position,
        });
      } else {
        drawnAs.set(e.id, e.id);
        nodes.push({
          id: e.id,
          kind: "file",
          label: basename(e.id),
          detail: folderOf(e.id),
          side,
          depth,
          cycle: cycles.has(e.id),
          members: [e.id],
          position,
        });
      }
    }
  }

  const merged = new Map<
    string,
    {
      source: string;
      target: string;
      hint: boolean;
      kinds: Set<EdgeKind>;
      outward: boolean;
      count: number;
    }
  >();
  for (const e of hood.edges) {
    const source = drawnAs.get(e.source);
    const target = drawnAs.get(e.target);
    if (source === undefined || target === undefined || source === target) {
      continue;
    }
    const id = `${source}->${target}${e.hint ? " (hint)" : ""}`;
    const m = merged.get(id);
    if (m) {
      for (const k of e.kinds) m.kinds.add(k);
      m.outward ||= e.outward;
      m.count++;
    } else {
      merged.set(id, {
        source,
        target,
        hint: e.hint,
        kinds: new Set(e.kinds),
        outward: e.outward,
        count: 1,
      });
    }
  }

  return {
    nodes: nodes.sort((a, b) => compare(a.id, b.id)),
    edges: [...merged.entries()]
      .sort(([a], [b]) => compare(a, b))
      .map(([id, m]) => ({
        id,
        source: m.source,
        target: m.target,
        kinds: [...m.kinds].sort(),
        hint: m.hint,
        outward: m.outward,
        count: m.count,
      })),
  };
}
