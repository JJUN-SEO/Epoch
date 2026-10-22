import cytoscape, { type StylesheetJson } from "cytoscape";
import { describe, expect, it } from "vitest";
import { highlightNeighbors, wheelZoomFactor } from "./cy";
import { graphStylesheet } from "./style";
import type { CanvasTheme } from "./theme";

describe("wheelZoomFactor", () => {
  const wheel = (deltaY: number, deltaMode = 0, ctrlKey = false) =>
    wheelZoomFactor({ deltaY, deltaMode, ctrlKey });

  it("zooms about 15% per mouse-wheel notch, in and out alike", () => {
    expect(wheel(-100)).toBeCloseTo(2 ** 0.2, 10);
    expect(wheel(-100)).toBeGreaterThan(1.14);
    expect(wheel(100) * wheel(-100)).toBeCloseTo(1, 10);
  });

  it("is proportional for trackpads and faster for pinches", () => {
    expect(wheel(-4) ** 25).toBeCloseTo(wheel(-100), 10);
    expect(wheel(-10, 0, true)).toBeCloseTo(wheel(-100), 10);
  });

  it("reads line and page deltas in their units", () => {
    expect(wheel(-2, 1)).toBeCloseTo(2 ** 0.1, 10);
    expect(wheel(-1, 2)).toBe(2);
  });
});

describe("highlightNeighbors", () => {
  const graph = () =>
    cytoscape({
      headless: true,
      elements: [
        { data: { id: "a" } },
        { data: { id: "b" } },
        { data: { id: "c" } },
        { data: { id: "ab", source: "a", target: "b" } },
      ],
    });

  it("marks the node itself as the center, its neighbors as highlighted", () => {
    const cy = graph();
    highlightNeighbors(cy, "a", { fade: false });
    expect(cy.$id("a").hasClass("center")).toBe(true);
    expect(cy.$id("a").hasClass("hl")).toBe(true);
    expect(cy.$id("b").hasClass("hl")).toBe(true);
    expect(cy.$id("b").hasClass("center")).toBe(false);
    expect(cy.$id("c").hasClass("hl")).toBe(false);
    highlightNeighbors(cy, undefined, { fade: false });
    expect(cy.$id("a").hasClass("center")).toBe(false);
    expect(cy.$id("b").hasClass("hl")).toBe(false);
  });
});

describe("graphStylesheet", () => {
  const theme = Object.fromEntries(
    [
      "canvas",
      "text",
      "muted",
      "faint",
      "border",
      "chrome",
      "accent",
      "imports",
      "dependents",
      "danger",
      "edge",
    ].map((k) => [k, "#000000"]),
  ) as unknown as CanvasTheme;
  /** The last min-zoomed-font-size a selector sets (later rules win). */
  const minZoomed = (sheet: StylesheetJson, selector: string): unknown => {
    // Rules as plain data: Cytoscape's types make style keys per element group.
    const rules = sheet as unknown as readonly {
      readonly selector?: string;
      readonly style?: Readonly<Record<string, unknown>>;
    }[];
    return rules
      .filter((r) => r.selector === selector)
      .map((r) => r.style?.["min-zoomed-font-size"])
      .filter((v) => v !== undefined)
      .at(-1);
  };

  it("in a large graph, shows names around a hovered file only zoomed in close, except its own", () => {
    const large = graphStylesheet(theme, { large: true });
    expect(minZoomed(large, "node.hl")).toBe(12);
    expect(minZoomed(large, "node.center, node:selected")).toBe(0);
    // A small graph still names a hovered file's neighbors at any zoom.
    expect(minZoomed(graphStylesheet(theme), "node.hl")).toBe(0);
  });
});
