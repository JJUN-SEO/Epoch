import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { E2E_FUSES, INSTALLER_FUSES } from "../e2e/packaging";

// The packaging configs (ADR-018): installers are built from
// electron-builder.yml alone; the e2e build extends it and changes one fuse.
const config = (name: string): Record<string, unknown> =>
  parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;

describe("electron-builder.yml", () => {
  const base = config("electron-builder.yml");

  it("flips the fuses the installers ship with", () => {
    expect(base.electronFuses).toEqual(INSTALLER_FUSES);
  });

  it("publishes nothing itself (the release workflow uploads)", () => {
    expect(base.publish).toBeNull();
  });
});

describe("electron-builder.e2e.yml", () => {
  const e2e = config("electron-builder.e2e.yml");

  it("extends the installer config and only turns the inspector back on", () => {
    expect(e2e).toEqual({
      extends: "./electron-builder.yml",
      electronFuses: { enableNodeCliInspectArguments: true },
    });
    expect({ ...INSTALLER_FUSES, ...(e2e.electronFuses as object) }).toEqual(
      E2E_FUSES,
    );
  });

  it("is what the e2e suite packages", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["package:dir"]).toBe(
      "electron-builder --dir --config electron-builder.e2e.yml",
    );
  });
});
