import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Force,
  type SimulationNode,
} from "d3-force-3d";
import type { Layout3DFrame, Layout3DRequest } from "./layout3d-protocol";

/*
 * A 3D force layout (d3-force-3d) off the UI thread. Links pull imports
 * together, every node repels the others, and a weak pull toward each
 * folder's center keeps folders together. Intermediate frames stream back,
 * so the graph settles on screen instead of appearing after a wait.
 */

type Node = SimulationNode & { x: number; y: number; z: number };

const FRAME_EVERY = 15;
/*
 * Repulsion (Barnes-Hut) is nearly all of the cost. Measured on vitest
 * (2,451 files, docs/decisions/ADR-012-3d-overview.md): theta 0.9 and d3's
 * default cooling took 12–14 s; theta 1.2 and twice the cooling rate (149
 * ticks instead of 300) take about 4.6 s.
 */
const THETA = 1.2;
const ALPHA_DECAY = 0.0456;

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

self.onmessage = (event: MessageEvent<Layout3DRequest>) => {
  const started = performance.now();
  const { id, count, groups, links } = event.data;
  // No coordinates yet: d3 places the nodes on a deterministic spiral, and
  // its seeded random source keeps the layout reproducible.
  const nodes = Array.from({ length: count }, () => ({}) as Node);
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
    .alphaDecay(ALPHA_DECAY)
    .stop();
  // As many ticks as the simulation takes to cool from alpha 1 to alphaMin.
  const ticks = Math.ceil(
    Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay()),
  );
  const post = (done: boolean) => {
    const positions = positionsOf(nodes);
    const frame: Layout3DFrame = {
      id,
      positions,
      done,
      ms: performance.now() - started,
    };
    self.postMessage(frame, { transfer: [positions.buffer] });
  };
  for (let t = 1; t <= ticks; t++) {
    simulation.tick();
    if (t % FRAME_EVERY === 0 && t < ticks) post(false);
  }
  post(true);
};
