import type { FuseV1Options } from "@electron/fuses";

/**
 * What electron-builder.yml promises about the packaged app (ADR-018), shared
 * by the config test (src/packaging.test.ts), the packaged e2e suite and the
 * installer smoke test, so the three cannot drift apart.
 */

/** Electron's fuses as the installers ship them. */
export const INSTALLER_FUSES = {
  runAsNode: false,
  enableCookieEncryption: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  grantFileProtocolExtraPrivileges: false,
} as const;

/**
 * The CI-only unpacked build the e2e suite drives (electron-builder.e2e.yml):
 * the same, except that Playwright's launcher needs --inspect.
 */
export const E2E_FUSES = {
  ...INSTALLER_FUSES,
  enableNodeCliInspectArguments: true,
} as const;

export type Fuses = Readonly<Record<keyof typeof INSTALLER_FUSES, boolean>>;

/**
 * The fuses as an executable carries them, read from its fuse wire (on macOS
 * the path inside the .app bundle reaches the Electron Framework binary).
 */
export async function readFuses(executable: string): Promise<Fuses> {
  const { getCurrentFuseWire, FuseV1Options } = await import("@electron/fuses");
  const wire = await getCurrentFuseWire(executable);
  // A fuse is the byte "1" (enabled) or "0" (disabled) in the wire
  // (@electron/fuses 1.8.0, FuseState in dist/constants.d.ts).
  const state = (option: FuseV1Options): boolean => {
    const value: number | undefined = (
      wire as Partial<Record<FuseV1Options, number>>
    )[option];
    if (value === "1".charCodeAt(0)) return true;
    if (value === "0".charCodeAt(0)) return false;
    throw new Error(`fuse ${String(option)} is ${String(value)}`);
  };
  return {
    runAsNode: state(FuseV1Options.RunAsNode),
    enableCookieEncryption: state(FuseV1Options.EnableCookieEncryption),
    enableNodeOptionsEnvironmentVariable: state(
      FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    ),
    enableNodeCliInspectArguments: state(
      FuseV1Options.EnableNodeCliInspectArguments,
    ),
    enableEmbeddedAsarIntegrityValidation: state(
      FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    ),
    onlyLoadAppFromAsar: state(FuseV1Options.OnlyLoadAppFromAsar),
    grantFileProtocolExtraPrivileges: state(
      FuseV1Options.GrantFileProtocolExtraPrivileges,
    ),
  };
}
