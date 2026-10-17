import { describe, expect, it } from "vitest";
import { bytes, keyStatusText, parseUsd, usd } from "./model";

describe("settings helpers", () => {
  it("writes dollars, with more digits for small amounts", () => {
    expect(usd(5)).toBe("$5.00");
    expect(usd(0.0015)).toBe("$0.0015");
    expect(usd(0)).toBe("$0.00");
  });

  it("reads a dollar field: empty clears, junk and negatives are refused", () => {
    expect(parseUsd("")).toBeNull();
    expect(parseUsd(" 2.5 ")).toBe(2.5);
    expect(parseUsd("$3")).toBe(3);
    expect(parseUsd("0")).toBe(0);
    expect(parseUsd("-1")).toBeUndefined();
    expect(parseUsd("abc")).toBeUndefined();
    expect(parseUsd("1e400")).toBeUndefined();
  });

  it("says how a key is kept, never the key", () => {
    expect(keyStatusText({ configured: false })).toBe("Not set");
    expect(keyStatusText({ configured: true, storage: "encrypted" })).toBe(
      "Set, encrypted by your system",
    );
    expect(keyStatusText({ configured: true, storage: "session" })).toBe(
      "Set until Epoch quits",
    );
    expect(keyStatusText({ configured: true, storage: "weak" })).toBe(
      "Set, weakly protected (no keyring)",
    );
  });

  it("writes sizes", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(2048)).toBe("2.0 KB");
    expect(bytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
