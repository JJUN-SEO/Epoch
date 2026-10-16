import { describe, expect, it } from "vitest";
import { wheelZoomFactor } from "./cy";

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
