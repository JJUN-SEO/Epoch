import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, PANEL_MAX, PANEL_MIN, parsePrefs } from "./prefs";

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
      }),
    ).toEqual(DEFAULT_PREFS);
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
      }),
    ).toEqual({
      sidebar: false,
      inspector: false,
      sidebarWidth: PANEL_MIN,
      inspectorWidth: PANEL_MAX,
      colorBy: "language",
      hops: 3,
      inspectorTab: "neighbors",
    });
  });
});
