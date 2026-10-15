import type { LayoutRequest } from "./layout-protocol";

interface Point {
  x: number;
  y: number;
}

/** At least this share of the leaf nodes must have a position to refine instead of starting over. */
export const MIN_SEEDED_SHARE = 0.5;

/** A small, deterministic offset per id, so new nodes do not start on top of each other. */
function jitter(id: string, radius: number): Point {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const angle = ((h >>> 0) % 3600) * (Math.PI / 1800);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/**
 * Starting positions for every leaf node of a layout request, or undefined
 * when too few nodes have a previous position (then the layout starts from
 * random positions). A new node starts beside a positioned neighbor, else
 * where its folder was drawn (an opened folder), else beside a positioned
 * sibling, else at the center of everything. Pure, so it is unit-tested.
 */
export function seedPositions(
  request: Omit<LayoutRequest, "id">,
): Record<string, Point> | undefined {
  const seed = request.seed;
  if (!seed) return undefined;
  const parents = new Set(
    request.nodes.flatMap((n) => (n.parent === undefined ? [] : [n.parent])),
  );
  const leaves = request.nodes.filter((n) => !parents.has(n.id));
  if (leaves.length === 0) return undefined;
  const seeded = leaves.filter((n) => seed[n.id] !== undefined).length;
  if (seeded / leaves.length < MIN_SEEDED_SHARE) return undefined;

  const neighbors = new Map<string, string[]>();
  for (const e of request.edges) {
    neighbors.set(e.source, [...(neighbors.get(e.source) ?? []), e.target]);
    neighbors.set(e.target, [...(neighbors.get(e.target) ?? []), e.source]);
  }
  const siblings = new Map<string, string[]>();
  for (const n of leaves) {
    if (n.parent === undefined) continue;
    siblings.set(n.parent, [...(siblings.get(n.parent) ?? []), n.id]);
  }
  const known = Object.values(seed);
  const center = known.reduce(
    (c, p) => ({ x: c.x + p.x / known.length, y: c.y + p.y / known.length }),
    { x: 0, y: 0 },
  );
  const out: Record<string, Point> = {};
  for (const n of leaves) {
    const own = seed[n.id];
    if (own) {
      out[n.id] = { ...own };
      continue;
    }
    const anchor =
      (neighbors.get(n.id) ?? []).map((id) => seed[id]).find(Boolean) ??
      (n.parent === undefined ? undefined : seed[n.parent]) ??
      (n.parent === undefined
        ? undefined
        : (siblings.get(n.parent) ?? []).map((id) => seed[id]).find(Boolean)) ??
      center;
    const d = jitter(n.id, 30);
    out[n.id] = { x: anchor.x + d.x, y: anchor.y + d.y };
  }
  return out;
}
