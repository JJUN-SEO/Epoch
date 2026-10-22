import { BufferAttribute, BufferGeometry, SphereGeometry } from "three";

/*
 * The files of the 3D overview as one plain triangle mesh: a copy of a unit
 * sphere per file, colored per vertex, with the shading baked into the
 * colors. That is the same kind of drawing as the edges (an unlit material
 * with vertex colors, no instancing, no lights), which every GPU that shows
 * the edges also shows; an instanced, lit mesh drew nothing on some Windows
 * drivers. Pure apart from three's buffers, for the tests.
 */

/** The direction the baked light comes from (world space, normalized). */
const LIGHT = (() => {
  const [x, y, z] = [0.5, 1, 1];
  const n = Math.hypot(x, y, z);
  return [x / n, y / n, z / n] as const;
})();
/** Brightness of a vertex facing away from the light, and facing it. */
const SHADE_MIN = 0.62;
const SHADE_MAX = 1;

export interface SphereBatch {
  readonly geometry: BufferGeometry;
  /** Vertices per sphere. */
  readonly vertices: number;
  readonly count: number;
  /** The unit sphere's vertex positions (x, y, z per vertex). */
  readonly unit: Float32Array;
  /** Brightness per sphere vertex, from the baked light. */
  readonly shade: Float32Array;
}

/** Sphere detail by graph size: fewer triangles for larger graphs. */
export function sphereSegments(count: number): readonly [number, number] {
  if (count > 3000) return [6, 4];
  if (count > 600) return [8, 6];
  return [12, 8];
}

/** One mesh with `count` unit spheres, all at the origin until written. */
export function createSphereBatch(count: number): SphereBatch {
  const [width, height] = sphereSegments(count);
  const template = new SphereGeometry(1, width, height);
  const unit = Float32Array.from(template.getAttribute("position").array);
  const normal = template.getAttribute("normal").array;
  const index = template.getIndex()?.array ?? [];
  template.dispose();
  const vertices = unit.length / 3;
  const shade = new Float32Array(vertices);
  for (let v = 0; v < vertices; v++) {
    const facing =
      (normal[3 * v] ?? 0) * LIGHT[0] +
      (normal[3 * v + 1] ?? 0) * LIGHT[1] +
      (normal[3 * v + 2] ?? 0) * LIGHT[2];
    shade[v] = SHADE_MIN + (SHADE_MAX - SHADE_MIN) * Math.max(0, facing);
  }

  const total = count * vertices;
  const indices =
    total > 65_535
      ? new Uint32Array(count * index.length)
      : new Uint16Array(count * index.length);
  for (let i = 0; i < count; i++)
    for (let k = 0; k < index.length; k++)
      indices[i * index.length + k] = (index[k] ?? 0) + i * vertices;
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(total * 3), 3),
  );
  geometry.setAttribute(
    "color",
    new BufferAttribute(new Float32Array(total * 3), 3),
  );
  geometry.setIndex(new BufferAttribute(indices, 1));
  return { geometry, vertices, count, unit, shade };
}

/** Puts sphere `i` at `positions[3i..3i+2]` with radius `radius(i)`. */
export function writeSphereCenters(
  batch: SphereBatch,
  positions: Float32Array,
  radius: (i: number) => number,
): void {
  const attribute = batch.geometry.getAttribute("position") as BufferAttribute;
  const out = attribute.array as Float32Array;
  const { vertices, unit } = batch;
  for (let i = 0; i < batch.count; i++) {
    const r = radius(i);
    const cx = positions[3 * i] ?? 0;
    const cy = positions[3 * i + 1] ?? 0;
    const cz = positions[3 * i + 2] ?? 0;
    const base = 3 * i * vertices;
    for (let v = 0; v < vertices; v++) {
      out[base + 3 * v] = cx + (unit[3 * v] ?? 0) * r;
      out[base + 3 * v + 1] = cy + (unit[3 * v + 1] ?? 0) * r;
      out[base + 3 * v + 2] = cz + (unit[3 * v + 2] ?? 0) * r;
    }
  }
  attribute.needsUpdate = true;
}

/** Colors sphere `i` with `color(i)` (linear r, g, b), shaded by the baked light. */
export function writeSphereColors(
  batch: SphereBatch,
  color: (i: number) => {
    readonly r: number;
    readonly g: number;
    readonly b: number;
  },
): void {
  const attribute = batch.geometry.getAttribute("color") as BufferAttribute;
  const out = attribute.array as Float32Array;
  const { vertices, shade } = batch;
  for (let i = 0; i < batch.count; i++) {
    const { r, g, b } = color(i);
    const base = 3 * i * vertices;
    for (let v = 0; v < vertices; v++) {
      const s = shade[v] ?? 1;
      out[base + 3 * v] = r * s;
      out[base + 3 * v + 1] = g * s;
      out[base + 3 * v + 2] = b * s;
    }
  }
  attribute.needsUpdate = true;
}

/** A file as drawn on screen: its center in pixels, radius in pixels, depth (smaller is nearer). */
export interface ScreenDisc {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly depth: number;
}

/**
 * The file under a pointer: among the discs within `slop` pixels of it, the
 * nearest to the camera. Undefined over empty space.
 */
export function pickDisc(
  discs: readonly (ScreenDisc | undefined)[],
  x: number,
  y: number,
  slop: number,
): number | undefined {
  let best: number | undefined;
  let bestDepth = Infinity;
  for (const [i, d] of discs.entries()) {
    if (!d) continue;
    const reach = d.r + slop;
    if ((d.x - x) ** 2 + (d.y - y) ** 2 > reach * reach) continue;
    if (d.depth < bestDepth) {
      best = i;
      bestDepth = d.depth;
    }
  }
  return best;
}
