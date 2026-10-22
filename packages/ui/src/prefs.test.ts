import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREFS,
  HINT_THRESHOLD_MAX,
  HINT_THRESHOLD_MIN,
  PANEL_MAX,
  PANEL_MIN,
  parsePrefs,
} from "./prefs";

describe("parsePrefs", () => {
  it("defaults everything that is missing or invalid", () => {
    expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("nonsense")).toEqual(DEFAULT_PREFS);
    expect(
      parsePrefs({
        sidebar: "yes",
        hops: 7,
        colorBy: "taste",
        inspectorTab: 1,
        graphMode: "4d",
        hints: "on",
        hintThreshold: "high",
      }),
    ).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS.hints).toBe(false);
  });

  it("keeps the hint threshold between the floor and 0.95, in steps of 0.05", () => {
    expect(parsePrefs({ hintThreshold: 0.01 }).hintThreshold).toBe(
      HINT_THRESHOLD_MIN,
    );
    expect(parsePrefs({ hintThreshold: 1 }).hintThreshold).toBe(
      HINT_THRESHOLD_MAX,
    );
    expect(parsePrefs({ hintThreshold: 0.62 }).hintThreshold).toBe(0.6);
  });

  it("keeps valid values and clamps panel widths", () => {
    expect(
      parsePrefs({
        sidebar: false,
        inspector: false,
        sidebarWidth: 10,
        inspectorWidth: 9999,
        colorBy: "language",
        hops: 3,
        inspectorTab: "neighbors",
        graphMode: "3d",
        hints: true,
        hintThreshold: 0.7,
      }),
    ).toEqual({
      sidebar: false,
      inspector: false,
      sidebarWidth: PANEL_MIN,
      inspectorWidth: PANEL_MAX,
      colorBy: "language",
      hops: 3,
      inspectorTab: "neighbors",
      graphMode: "3d",
      hints: true,
      hintThreshold: 0.7,
    });
  });
});
