import { describe, expect, it } from "vitest";
import { isNewer, parseVersion } from "./version";

describe("parseVersion", () => {
  it("reads MAJOR.MINOR.PATCH, with or without a v", () => {
    expect(parseVersion("0.1.0")).toEqual([0, 1, 0]);
    expect(parseVersion("v10.20.30")).toEqual([10, 20, 30]);
  });

  it.each([
    "1.2",
    "1.2.3.4",
    "1.2.3-rc.1",
    "1.2.3+build",
    "01.2.3",
    "V1.2.3",
    " 1.2.3",
    "1.2.3\n",
    "9999999999.0.0",
    "",
  ])("refuses %j", (text) => {
    expect(parseVersion(text)).toBeUndefined();
  });
});

describe("isNewer", () => {
  it("compares numerically, part by part", () => {
    expect(isNewer("v0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("v1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("v0.1.1", "0.1.0")).toBe(true);
  });

  it("is false for the same or an older version", () => {
    expect(isNewer("v0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("v0.0.9", "0.1.0")).toBe(false);
  });

  it("is false when either is not a release version", () => {
    expect(isNewer("v2.0.0-beta", "0.1.0")).toBe(false);
    expect(isNewer("latest", "0.1.0")).toBe(false);
    expect(isNewer("v2.0.0", "dev")).toBe(false);
  });
});
