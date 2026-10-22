import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Force,
  type SimulationNode,
} from "d3-force-3d";

/*
 * The 3D force layout (d3-force-3d), run by layout3d.worker.ts off the UI
 * thread. Links pull imports together, every node repels the others, and a
 * weak pull toward each folder's center keeps folders together. Frames
 * stream back by time, starting with the starting positions, so the graph
 * is on screen at once and settles while you watch. Pure, for the tests.
 */

type Node = SimulationNode & { x: number; y: number; z: number };

/*
 * Repulsion (Barnes-Hut) is nearly all of the cost. Measured on vitest
 * (2,451 files, docs/decisions/ADR-012-3d-overview.md): theta 0.9 and d3's
 * default cooling took 12–14 s; theta 1.2 and twice the cooling rate (149
 * ticks instead of 300) take about 4.6 s.
 */
const THETA = 1.2;
const ALPHA_DECAY = 0.0456;
/**
 * A layout that starts from known positions (the graph changed a little)
 * starts cooler: it adjusts the new parts instead of shaking everything.
 */
export const WARM_ALPHA = 0.3;

export interface Simulation3DInput {
  readonly count: number;
  /** Folder index per node (graph3d/data.ts). */
  readonly groups: Int32Array;
  /** Edge endpoints as node indices, in pairs. */
  readonly links: Int32Array;
  /** Starting x, y, z per node, from a previous layout. */
  readonly initial?: Float32Array;
}

/** Pulls each node toward the center of its folder's nodes. */
function folderForce(groups: Int32Array, strength: number): Force<Node> {
  let nodes: Node[] = [];
  const groupCount = groups.reduce((m, g) => Math.max(m, g + 1), 0);
  const sum = new Float64Array(groupCount * 3);
  const size = new Int32Array(groupCount);
  for (const g of groups) size[g] = (size[g] ?? 0) + 1;
  const force = (alpha: number) => {
    sum.fill(0);
    for (const [i, n] of nodes.entries()) {
      const g = groups[i] ?? 0;
      sum[3 * g] = (sum[3 * g] ?? 0) + n.x;
      sum[3 * g + 1] = (sum[3 * g + 1] ?? 0) + n.y;
      sum[3 * g + 2] = (sum[3 * g + 2] ?? 0) + n.z;
    }
    const k = strength * alpha;
    for (const [i, n] of nodes.entries()) {
      const g = groups[i] ?? 0;
      const count = size[g] ?? 1;
      if (count < 2) continue;
      n.vx = (n.vx ?? 0) + ((sum[3 * g] ?? 0) / count - n.x) * k;
      n.vy = (n.vy ?? 0) + ((sum[3 * g + 1] ?? 0) / count - n.y) * k;
      n.vz = (n.vz ?? 0) + ((sum[3 * g + 2] ?? 0) / count - n.z) * k;
    }
  };
  force.initialize = (ns: Node[]) => {
    nodes = ns;
  };
  return force;
}

function positionsOf(nodes: readonly Node[]): Float32Array {
  const out = new Float32Array(nodes.length * 3);
  for (const [i, n] of nodes.entries()) {
    out[3 * i] = n.x;
    out[3 * i + 1] = n.y;
    out[3 * i + 2] = n.z;
  }
  return out;
}

/**
 * Lays out the graph, calling `emit` with the starting positions, then at
 * most once per `frameMs` while it runs, then once with `done`. Returns the
 * number of ticks it ran.
 */
export function simulate3d(
  input: Simulation3DInput,
  emit: (positions: Float32Array, done: boolean) => void,
  opts: { readonly now: () => number; readonly frameMs: number },
): number {
  const { count, groups, links, initial } = input;
  const start = initial?.length === count * 3 ? initial : undefined;
  const warm = start !== undefined;
  // Without starting positions d3 places the nodes on a deterministic
  // spiral, and its seeded random source keeps the layout reproducible.
  const nodes = Array.from({ length: count }, (_, i): Node =>
    start
      ? {
          x: start[3 * i] ?? 0,
          y: start[3 * i + 1] ?? 0,
          z: start[3 * i + 2] ?? 0,
        }
      : ({} as Node),
  );
  const linkList = Array.from({ length: links.length / 2 }, (_, i) => ({
    source: links[2 * i] ?? 0,
    target: links[2 * i + 1] ?? 0,
  }));
  const simulation = forceSimulation(nodes, 3)
    .force("link", forceLink<Node>(linkList).distance(30))
    .force(
      "charge",
      forceManyBody<Node>().strength(-45).theta(THETA).distanceMax(800),
    )
    .force("center", forceCenter<Node>())
    .force("folder", folderForce(groups, 0.06))
    .alpha(warm ? WARM_ALPHA : 1)
    .alphaDecay(ALPHA_DECAY)
    .stop();
  // As many ticks as the simulation takes to cool from its alpha to alphaMin.
  const ticks = Math.ceil(
    Math.log(simulation.alphaMin() / simulation.alpha()) /
      Math.log(1 - simulation.alphaDecay()),
  );
  emit(positionsOf(nodes), false);
  let last = opts.now();
  for (let t = 1; t <= ticks; t++) {
    simulation.tick();
    if (t < ticks && opts.now() - last >= opts.frameMs) {
      emit(positionsOf(nodes), false);
      last = opts.now();
    }
  }
  emit(positionsOf(nodes), true);
  return ticks;
}
