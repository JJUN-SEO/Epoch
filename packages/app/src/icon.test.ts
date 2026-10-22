import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

// The app icon: build/icon.svg, rendered to build/icon.png by
// scripts/render-icon.mjs. electron-builder makes every platform's icon from
// the PNG, which needs to be at least 512×512 (1024 for a sharp macOS icon).
const build = new URL("../build/", import.meta.url);

describe("app icon", () => {
  const png = readFileSync(new URL("icon.png", build));

  it("is a 1024×1024 RGBA PNG", () => {
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.toString("latin1", 12, 16)).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // color type: RGBA
  });

  it("has transparent corners (the rounded body is drawn, not the square)", () => {
    // The first pixel of the first row is stored as-is under every PNG
    // filter, so it can be read straight after the row's filter byte.
    const idat: Buffer[] = [];
    for (let at = 8; at < png.length;) {
      const length = png.readUInt32BE(at);
      if (png.toString("latin1", at + 4, at + 8) === "IDAT")
        idat.push(png.subarray(at + 8, at + 8 + length));
      at += length + 12;
    }
    const pixels = inflateSync(Buffer.concat(idat));
    expect(pixels[4]).toBe(0); // alpha of (0, 0)
  });

  it("is a plain drawing: no script, embedded image or remote reference", () => {
    const svg = readFileSync(new URL("icon.svg", build), "utf8");
    expect(svg).toMatch(/viewBox="0 0 1024 1024"/);
    expect(svg).not.toMatch(/<script|<image|<foreignObject|<use|href=/i);
  });
});
