import { describe, expect, it } from "vitest";
import { drawingWorks, type Pixel } from "./drawing-check";

const RED: Pixel = [255, 0, 0, 255];
const BLACK: Pixel = [0, 0, 0, 255];

/** A fake GPU: what each side shows after each frame. */
function gpu(frames: Record<"left" | "right", Pixel>[]) {
  let frame = -1;
  return {
    draw: () => {
      frame++;
    },
    read: (side: "left" | "right") => frames[frame]?.[side] ?? BLACK,
  };
}

describe("drawingWorks", () => {
  it("passes when the mark moves and the old frame is cleared", () => {
    const g = gpu([
      { left: RED, right: BLACK },
      { left: BLACK, right: RED },
    ]);
    expect(drawingWorks(g.draw, g.read)).toBe(true);
  });

  it("fails when triangles are not drawn", () => {
    const g = gpu([
      { left: BLACK, right: BLACK },
      { left: BLACK, right: BLACK },
    ]);
    expect(drawingWorks(g.draw, g.read)).toBe(false);
  });

  it("fails when an old frame stays on screen (trails)", () => {
    const g = gpu([
      { left: RED, right: BLACK },
      { left: RED, right: RED },
    ]);
    expect(drawingWorks(g.draw, g.read)).toBe(false);
  });

  it("fails when the wrong colors come back", () => {
    const g = gpu([
      { left: [0, 0, 255, 255], right: BLACK },
      { left: BLACK, right: [0, 0, 255, 255] },
    ]);
    expect(drawingWorks(g.draw, g.read)).toBe(false);
  });
});
