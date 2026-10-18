import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const builder = parse(
  fs.readFileSync(
    new URL("../../../packages/app/electron-builder.yml", import.meta.url),
    "utf8",
  ),
) as {
  dmg: { artifactName: string };
  nsis: { artifactName: string };
  appImage: { artifactName: string };
  deb: { artifactName: string };
};

describe("static landing page", () => {
  it("links to the exact names electron-builder emits", () => {
    const names = [
      builder.dmg,
      builder.nsis,
      builder.appImage,
      builder.deb,
    ].map(({ artifactName }, i) =>
      artifactName.replace(
        "${ext}",
        ["dmg", "exe", "AppImage", "deb"][i] ?? "",
      ),
    );
    const hrefs = [
      ...html.matchAll(
        /href="https:\/\/github\.com\/JJUN-SEO\/Epoch\/releases\/latest\/download\/(Epoch-[^"]+)"/g,
      ),
    ].map((match) => match[1]);
    expect(hrefs.sort()).toEqual(names.sort());
  });

  it("has a strict policy and no script", () => {
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toMatch(/<script\b/i);
  });
});
