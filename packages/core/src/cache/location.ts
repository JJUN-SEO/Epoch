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
