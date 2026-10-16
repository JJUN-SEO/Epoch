import type { LayoutRequest, LayoutResponse } from "./layout-protocol";

/*
 * Recent layouts, by what was laid out. The graph view asks for a layout
 * whenever the visible graph changes, but often only its object changed (a
 * saved file whose imports did not) or it went back to folders it showed
 * before (a folder closed again, the starting view). Laying out again would
 * move everything; a key says the picture can stay, or come back.
 */

/** What a layout depends on: nodes with their folder and size, edges, and the mode. Seeds are not part of it. */
export function layoutKey(request: Omit<LayoutRequest, "id" | "seed">): string {
  return JSON.stringify([
    request.packed === true,
    request.nodes.map((n) => [n.id, n.parent ?? null, n.size]),
    request.edges.map((e) => [e.source, e.target]),
  ]);
}

/**
 * The last `max` layouts by key, least recently used dropped first. The
 * first layout stored (the starting view) is never dropped.
 */
export class LayoutCache {
  private readonly entries = new Map<string, LayoutResponse>();
  private first: string | undefined;
  private readonly max: number;

  constructor(max = 8) {
    this.max = max;
  }

  get(key: string): LayoutResponse | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, layout: LayoutResponse): void {
    this.first ??= key;
    this.entries.delete(key);
    this.entries.set(key, layout);
    for (const k of this.entries.keys()) {
      if (this.entries.size <= this.max) break;
      if (k !== this.first) this.entries.delete(k);
    }
  }
}
