import type { LayoutRequest } from "./layout-protocol";

/*
 * The layout for large graphs (expand-all on a big repository). fcose's time
 * grows far faster than the graph once hundreds of nested folders are open
 * (3.2 s at 1,200 nodes, 67 s at 3,100 on vitest), and laying out packed
 * folders with it instead leaves large boxes overlapping. So a large graph
 * is packed: each folder's files in a grid, in name order, its subfolders as
 * boxes beside them, recursively, like a file tree drawn as nested boxes.
 * Edges are drawn over it as usual. Nothing overlaps, it takes milliseconds,
 * and it is deterministic, so the picture stays put while files change.
 *
 * The packing also gives each open folder's rectangle, so the canvas draws
 * folders as plain rectangles behind the files instead of Cytoscape compound
 * nodes: with hundreds of nested compounds, Cytoscape restyles every
 * ancestor of each element it draws, which stalled the page for seconds.
 */

/** Drawn files (and closed folders) above which a graph is laid out and drawn as a large graph. */
export const PACK_ABOVE_FILES = 800;

/** Whether the visible graph is large: more leaves drawn than PACK_ABOVE_FILES. */
export function isLargeGraph(visible: {
  readonly nodes: readonly {
    readonly kind: string;
    readonly collapsed: boolean;
  }[];
}): boolean {
  let leaves = 0;
  for (const n of visible.nodes) {
    if (n.kind !== "dir" || n.collapsed) leaves++;
  }
  return leaves > PACK_ABOVE_FILES;
}

interface Point {
  x: number;
  y: number;
}

/** Spacing in model units, matching the display stylesheet (style.ts). */
export const PACK = {
  /** A file and room for its label below. */
  cellWidth: 80,
  cellHeight: 44,
  /** Between packed items. */
  gap: 24,
  /** A folder's padding (style.ts ":parent" padding) and its label above. */
  padding: 16,
  label: 18,
};

/** An open folder's rectangle: its center and size, and its label's font size. */
export interface Frame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Larger folders get larger labels, so they can be read zoomed out. */
  readonly labelSize: number;
}

/** A folder label's font size for a frame this wide. */
export const frameLabelSize = (width: number): number =>
  Math.round(Math.min(72, Math.max(12, width / 24)));

interface Packed {
  readonly width: number;
  readonly height: number;
  /** File offsets from the packed area's top-left corner. */
  readonly offsets: Map<string, Point>;
  /** Folder rectangles, with centers relative to the same corner. */
  readonly frames: Map<string, Frame>;
}

const moved = (packed: Packed, dx: number, dy: number) => ({
  offsets: [...packed.offsets].map(
    ([id, p]) => [id, { x: p.x + dx, y: p.y + dy }] as const,
  ),
  frames: [...packed.frames].map(
    ([id, f]) => [id, { ...f, x: f.x + dx, y: f.y + dy }] as const,
  ),
});

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Leaves in a near-square grid, in id order. Cells fit the largest leaf (a
 * closed folder is drawn larger than a file) with room for its label.
 */
function grid(
  leaves: readonly string[],
  sizeOf: (id: string) => number,
): Packed {
  const largest = Math.max(0, ...leaves.map(sizeOf));
  const cellWidth = Math.max(PACK.cellWidth, largest + PACK.gap);
  const cellHeight = Math.max(PACK.cellHeight, largest + PACK.cellHeight - 14);
  const cols = Math.max(1, Math.ceil(Math.sqrt(leaves.length)));
  const rows = Math.ceil(leaves.length / cols);
  const offsets = new Map<string, Point>();
  leaves.forEach((f, i) => {
    offsets.set(f, {
      x: (i % cols) * cellWidth + cellWidth / 2,
      y: Math.floor(i / cols) * cellHeight + largest / 2 + 4,
    });
  });
  return {
    width: cols * cellWidth,
    height: rows * cellHeight,
    offsets,
    frames: new Map(),
  };
}

/** A folder as an item: its contents inside padding, its label above, its rectangle recorded. */
function framed(folder: string, inner: Packed): Packed {
  const width = inner.width + 2 * PACK.padding;
  const boxHeight = inner.height + 2 * PACK.padding;
  const labelSize = frameLabelSize(width);
  // The label sits above the box (style.ts: text-margin-y -6).
  const label = Math.max(PACK.label, Math.ceil(labelSize * 1.25) + 6);
  const shifted = moved(inner, PACK.padding, PACK.padding + label);
  return {
    width,
    height: boxHeight + label,
    offsets: new Map(shifted.offsets),
    frames: new Map([
      [
        folder,
        {
          x: width / 2,
          y: label + boxHeight / 2,
          width,
          height: boxHeight,
          labelSize,
        },
      ],
      ...shifted.frames,
    ]),
  };
}

/** The width and height a packing aims for: a landscape screen. */
export const PACK_ASPECT = 1.6;

/** Row widths tried, as multiples of the width a perfect fill would need. */
const ROW_WIDTHS = [0.6, 0.8, 1, 1.25, 1.6, 2, 2.5];

/** Where each item goes in rows no wider than `rowWidth`, in the given order. */
function shelfPlaces(items: readonly Packed[], rowWidth: number) {
  const places: Point[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  for (const it of items) {
    if (x > 0 && x + it.width > rowWidth) {
      x = 0;
      y += rowHeight + PACK.gap;
      rowHeight = 0;
    }
    places.push({ x, y });
    x += it.width + PACK.gap;
    rowHeight = Math.max(rowHeight, it.height);
    width = Math.max(width, x - PACK.gap);
  }
  return { places, width, height: y + rowHeight };
}

/**
 * Shelf packing in the given order. Of a few row widths, the one whose
 * result fits a PACK_ASPECT screen at the largest scale wins, so a folder
 * with one or two big subfolders does not end up as a tall column.
 */
function shelves(items: readonly Packed[]): Packed {
  const first = items[0];
  if (items.length === 1 && first) return first;
  const area = items.reduce(
    (s, it) => s + (it.width + PACK.gap) * (it.height + PACK.gap),
    0,
  );
  const widest = Math.max(...items.map((it) => it.width));
  const ideal = Math.sqrt(area * PACK_ASPECT);
  let best = shelfPlaces(items, Math.max(widest, ideal));
  let bestScore = Math.max(best.width / PACK_ASPECT, best.height);
  for (const f of ROW_WIDTHS) {
    const candidate = shelfPlaces(items, Math.max(widest, ideal * f));
    const score = Math.max(candidate.width / PACK_ASPECT, candidate.height);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  const offsets = new Map<string, Point>();
  const frames = new Map<string, Frame>();
  items.forEach((it, i) => {
    const place = best.places[i] ?? { x: 0, y: 0 };
    const at = moved(it, place.x, place.y);
    for (const [id, p] of at.offsets) offsets.set(id, p);
    for (const [id, f] of at.frames) frames.set(id, f);
  });
  return { width: best.width, height: best.height, offsets, frames };
}

/** Every leaf node's position and every open folder's rectangle in the packed layout. */
export function packedLayout(request: Omit<LayoutRequest, "id">): {
  positions: Record<string, Point>;
  frames: Record<string, Frame>;
} {
  const sizes = new Map(request.nodes.map((n) => [n.id, n.size]));
  const sizeOf = (id: string) => sizes.get(id) ?? 14;
  const children = new Map<string, string[]>();
  for (const n of request.nodes) {
    const key = n.parent ?? "";
    const list = children.get(key);
    if (list) list.push(n.id);
    else children.set(key, [n.id]);
  }
  for (const list of children.values()) list.sort(byId);
  const isFolder = (id: string) => children.has(id);

  // A folder's own files first, then its subfolders, all in name order.
  const pack = (folder: string): Packed => {
    const kids = children.get(folder) ?? [];
    const leaves = kids.filter((k) => !isFolder(k));
    const items = [
      ...(leaves.length > 0 ? [grid(leaves, sizeOf)] : []),
      ...kids.filter(isFolder).map((f) => framed(f, pack(f))),
    ];
    return items.length > 0 ? shelves(items) : grid([], sizeOf);
  };

  const root = pack("");
  const centered = moved(root, -root.width / 2, -root.height / 2);
  return {
    positions: Object.fromEntries(centered.offsets),
    frames: Object.fromEntries(centered.frames),
  };
}
