import fs from "node:fs";
import path from "node:path";

/** Thrown when the renderer asks for a folder the user never granted. */
export class NotGrantedError extends Error {
  constructor() {
    super(
      "Epoch opens only folders chosen in its folder dialog, dropped on the window, or listed in Recent projects.",
    );
    this.name = "NotGrantedError";
  }
}

/** The real path of an existing folder; throws otherwise. */
export function realFolder(folder: string): string {
  if (!path.isAbsolute(folder)) {
    throw new Error("Expected an absolute folder path.");
  }
  const real = fs.realpathSync.native(folder);
  if (!fs.statSync(real).isDirectory()) {
    throw new Error("Not a folder.");
  }
  return real;
}

/**
 * Folders the user granted through a gesture main can trust: its own native
 * dialog, a real drop (the path comes from the preload, which page script
 * cannot forge), or the recent list main stores itself. The renderer cannot
 * add to this set; it can only name a folder already in it.
 *
 * Folders are compared by real path, so a symlink is judged by where it
 * points: a link to an ungranted folder is refused, and a granted folder later
 * replaced by a link elsewhere is refused too.
 */
export class GrantedRoots {
  private readonly roots = new Set<string>();

  /** Grants an existing folder and returns its real path. */
  grant(folder: string): string {
    const real = realFolder(folder);
    this.roots.add(real);
    return real;
  }

  /**
   * Grants a folder from the stored recent list, only if it still is the
   * real folder that was stored (not replaced by a symlink). Returns whether
   * it was granted.
   */
  grantStored(folder: string): boolean {
    try {
      if (realFolder(folder) !== folder) return false;
    } catch {
      return false;
    }
    this.roots.add(folder);
    return true;
  }

  /** The real path of a granted folder; throws NotGrantedError otherwise. */
  resolve(folder: string): string {
    let real: string;
    try {
      real = realFolder(folder);
    } catch {
      throw new NotGrantedError();
    }
    if (!this.roots.has(real)) throw new NotGrantedError();
    return real;
  }
}
