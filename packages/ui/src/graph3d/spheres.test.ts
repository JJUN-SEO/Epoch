import type { BufferAttribute } from "three";
import { describe, expect, it } from "vitest";
import {
  createSphereBatch,
  pickDisc,
  sphereSegments,
  writeSphereCenters,
  writeSphereColors,
} from "./spheres";

const array = (batch: ReturnType<typeof createSphereBatch>, name: string) =>
  (batch.geometry.getAttribute(name) as BufferAttribute).array as Float32Array;

describe("sphere batch", () => {
  it("holds one sphere per file in a single plain mesh", () => {
    const batch = createSphereBatch(3);
    const [w, h] = sphereSegments(3);
    expect(batch.vertices).toBe((w + 1) * (h + 1));
    expect(array(batch, "position")).toHaveLength(3 * batch.vertices * 3);
    // Each sphere's triangles use its own vertices.
    const index = batch.geometry.getIndex()?.array ?? [];
    const per = index.length / 3;
    const last = [...index].slice(2 * per);
    expect(Math.min(...last)).toBeGreaterThanOrEqual(2 * batch.vertices);
    expect(Math.max(...last)).toBeLessThan(3 * batch.vertices);
  });

  it("places each sphere at its file, sized by its radius", () => {
    const batch = createSphereBatch(2);
    writeSphereCenters(batch, new Float32Array([0, 0, 0, 10, 20, 30]), (i) =>
      i === 0 ? 1 : 2,
    );
    const pos = array(batch, "position");
    const start = 3 * batch.vertices;
    for (let v = 0; v < batch.vertices; v++) {
      const dx = (pos[start + 3 * v] ?? 0) - 10;
      const dy = (pos[start + 3 * v + 1] ?? 0) - 20;
      const dz = (pos[start + 3 * v + 2] ?? 0) - 30;
      expect(Math.hypot(dx, dy, dz)).toBeCloseTo(2, 4);
    }
  });

  it("colors each sphere, darker on the side away from the light", () => {
    const batch = createSphereBatch(1);
    writeSphereColors(batch, () => ({ r: 1, g: 0.5, b: 0 }));
    const color = array(batch, "color");
    const reds = Array.from(
      { length: batch.vertices },
      (_, v) => color[3 * v] ?? 0,
    );
    expect(Math.max(...reds)).toBeCloseTo(1, 2);
    expect(Math.min(...reds)).toBeGreaterThan(0.5);
    expect(Math.min(...reds)).toBeLessThan(0.7);
    for (let v = 0; v < batch.vertices; v++)
      expect(color[3 * v + 1]).toBeCloseTo((color[3 * v] ?? 0) / 2, 5);
  });

  it("uses fewer triangles for large graphs", () => {
    const small = sphereSegments(100);
    const large = sphereSegments(5000);
    expect(large[0] * large[1]).toBeLessThan(small[0] * small[1]);
    expect(createSphereBatch(5000).geometry.getIndex()?.array).toBeInstanceOf(
      Uint32Array,
    );
  });
});

describe("pickDisc", () => {
  const discs = [
    { x: 100, y: 100, r: 5, depth: 0.5 },
    { x: 103, y: 100, r: 5, depth: 0.2 },
    undefined,
    { x: 300, y: 300, r: 2, depth: 0.1 },
  ];

  it("picks the nearest file under the pointer", () => {
    expect(pickDisc(discs, 101, 100, 2)).toBe(1);
    expect(pickDisc(discs, 94, 100, 2)).toBe(0);
  });

  it("allows a few pixels of slop around small files, and nothing over empty space", () => {
    expect(pickDisc(discs, 303, 300, 2)).toBe(3);
    expect(pickDisc(discs, 306, 300, 2)).toBeUndefined();
    expect(pickDisc(discs, 200, 200, 2)).toBeUndefined();
  });
});
