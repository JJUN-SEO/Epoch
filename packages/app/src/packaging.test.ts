import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { E2E_FUSES, INSTALLER_FUSES, INSTALLER_NAMES } from "../e2e/packaging";

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

  it("builds a dmg for Apple Silicon, NSIS for Windows x64, AppImage and deb for Linux x64", () => {
    const targets = (os: string) =>
      (base[os] as { target: { target: string; arch: string[] }[] }).target;
    expect(targets("mac")).toEqual([{ target: "dmg", arch: ["arm64"] }]);
    expect(targets("win")).toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(targets("linux")).toEqual([
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ]);
  });

  it("names each installer without a version", () => {
    const name = (section: string) =>
      (base[section] as { artifactName: string }).artifactName;
    const built = {
      darwin: [name("dmg").replace("${ext}", "dmg")],
      win32: [name("nsis").replace("${ext}", "exe")],
      linux: [
        name("appImage").replace("${ext}", "AppImage"),
        name("deb").replace("${ext}", "deb"),
      ],
    };
    expect(built).toEqual(INSTALLER_NAMES);
    for (const files of Object.values(INSTALLER_NAMES))
      for (const file of files) expect(file).not.toMatch(/\d+\.\d+/);
  });

  it("names the packaged app epoch, so Windows installs to Programs\\epoch", () => {
    expect(base.extraMetadata).toEqual({ name: "epoch" });
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { productName?: string };
    // Electron's app name (and the data folder under it) is the productName.
    expect(pkg.productName).toBe("Epoch");
  });

  it("installs per user on Windows, keeping the user's data on uninstall", () => {
    expect(base.nsis).toMatchObject({
      oneClick: true,
      perMachine: false,
      deleteAppDataOnUninstall: false,
    });
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
