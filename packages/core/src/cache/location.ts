/** Overrides the cache directory (tests, benchmarks, CI caches). */
export const CACHE_DIR_ENV = "EPOCH_CACHE_DIR";

export interface CacheDirInputs {
  /** process.platform */
  readonly platform: string;
  /** process.env */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** os.homedir() */
  readonly homedir: string;
}

const APP = "epoch";

/**
 * The one per-user cache directory the app and the CLI share (CLAUDE.md
 * "Local cache"). Pure, so `core` stays free of I/O: the caller passes the
 * process values. Never inside an analyzed project.
 *
 * - `EPOCH_CACHE_DIR`, when set, wins (the caller resolves a relative value).
 * - macOS: `~/Library/Caches/epoch`, per Apple's File System Programming Guide
 *   (https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemOverview/FileSystemOverview.html).
 * - Windows: `%LOCALAPPDATA%\epoch\Cache` (FOLDERID_LocalAppData,
 *   https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid).
 * - Everything else: `$XDG_CACHE_HOME/epoch`, or `~/.cache/epoch` when it is
 *   unset or relative, which the XDG Base Directory spec says to ignore
 *   (https://specifications.freedesktop.org/basedir-spec/latest/).
 */
export function resolveCacheDir({
  platform,
  env,
  homedir,
}: CacheDirInputs): string {
  const override = env[CACHE_DIR_ENV];
  if (override !== undefined && override !== "") return override;
  if (platform === "darwin") return `${homedir}/Library/Caches/${APP}`;
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    const base =
      local !== undefined && local !== ""
        ? local
        : `${homedir}\\AppData\\Local`;
    return `${base}\\${APP}\\Cache`;
  }
  const xdg = env.XDG_CACHE_HOME;
  return xdg?.startsWith("/") === true
    ? `${xdg}/${APP}`
    : `${homedir}/.cache/${APP}`;
}

/** Overrides the data directory (tests). */
export const DATA_DIR_ENV = "EPOCH_DATA_DIR";

/**
 * The per-user data directory for what Epoch must keep (dismissed findings).
 * Not the cache: the cache is derived and safe to delete, this is not. Never
 * inside an analyzed project. Pure, like resolveCacheDir.
 *
 * - `EPOCH_DATA_DIR`, when set, wins.
 * - macOS: `~/Library/Application Support/epoch` (Apple's File System
 *   Programming Guide, as above).
 * - Windows: `%LOCALAPPDATA%\epoch\Data` (FOLDERID_LocalAppData, as above;
 *   local, not roaming: the data names this machine's folders).
 * - Everything else: `$XDG_DATA_HOME/epoch`, or `~/.local/share/epoch` when it
 *   is unset or relative (XDG Base Directory spec, as above).
 */
export function resolveDataDir({
  platform,
  env,
  homedir,
}: CacheDirInputs): string {
  const override = env[DATA_DIR_ENV];
  if (override !== undefined && override !== "") return override;
  if (platform === "darwin") {
    return `${homedir}/Library/Application Support/${APP}`;
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    const base =
      local !== undefined && local !== ""
        ? local
        : `${homedir}\\AppData\\Local`;
    return `${base}\\${APP}\\Data`;
  }
  const xdg = env.XDG_DATA_HOME;
  return xdg?.startsWith("/") === true
    ? `${xdg}/${APP}`
    : `${homedir}/.local/share/${APP}`;
}
