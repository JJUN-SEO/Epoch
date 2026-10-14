import fs from "node:fs";
import path from "node:path";
import type { FileReader } from "@epoch-dev/core";
import { toPosix } from "./discover.js";

/** Case-insensitive file systems by default (macOS, Windows). */
const CASE_INSENSITIVE =
  process.platform === "darwin" || process.platform === "win32";

/**
 * A FileReader confined to the project root (CLAUDE.md: the analysis host
 * reads only inside the opened folder). Every path is normalized and checked;
 * anything outside the root reads as missing. It never writes, never follows a
 * symlink out of the root, and never executes anything.
 */
export class FsReader implements FileReader {
  private readonly root: string;
  /** The root as given and its real path (they differ when the root sits behind a symlink, e.g. macOS /var -> /private/var). */
  private readonly rootKeys: readonly string[];

  constructor(root: string) {
    this.root = toPosix(path.resolve(root));
    let real = this.root;
    try {
      real = toPosix(fs.realpathSync.native(this.root));
    } catch {
      // keep the resolved path
    }
    this.rootKeys = [...new Set([this.key(this.root), this.key(real)])];
  }

  private key(p: string): string {
    return CASE_INSENSITIVE ? p.toLowerCase() : p;
  }

  /** Absolute normalized path if it lies inside the root, else undefined. */
  private inside(p: string): string | undefined {
    const abs = toPosix(path.resolve(this.root, p));
    const k = this.key(abs);
    return this.rootKeys.some((r) => k === r || k.startsWith(`${r}/`))
      ? abs
      : undefined;
  }

  private stat(p: string): fs.Stats | undefined {
    const abs = this.inside(p);
    if (abs === undefined) return undefined;
    try {
      // Refuse targets whose real location is outside the root.
      if (this.inside(toPosix(fs.realpathSync.native(abs))) === undefined)
        return undefined;
      return fs.statSync(abs);
    } catch {
      return undefined;
    }
  }

  /** Size and timestamps (ns) of a regular file inside the root, or undefined. */
  statFile(
    p: string,
  ): { size: number; mtimeNs: bigint; ctimeNs: bigint } | undefined {
    const abs = this.inside(p);
    if (abs === undefined || !this.stat(p)?.isFile()) return undefined;
    try {
      const st = fs.statSync(abs, { bigint: true });
      return {
        size: Number(st.size),
        mtimeNs: st.mtimeNs,
        ctimeNs: st.ctimeNs,
      };
    } catch {
      return undefined;
    }
  }

  readFile(p: string): string | undefined {
    if (!this.stat(p)?.isFile()) return undefined;
    try {
      return fs.readFileSync(this.inside(p) ?? "", "utf8");
    } catch {
      return undefined;
    }
  }

  readBytes(p: string): Buffer | undefined {
    if (!this.stat(p)?.isFile()) return undefined;
    try {
      return fs.readFileSync(this.inside(p) ?? "");
    } catch {
      return undefined;
    }
  }

  fileExists(p: string): boolean {
    return this.stat(p)?.isFile() ?? false;
  }

  directoryExists(p: string): boolean {
    return this.stat(p)?.isDirectory() ?? false;
  }

  getDirectories(p: string): string[] {
    const abs = this.inside(p);
    if (abs === undefined || !this.directoryExists(abs)) return [];
    try {
      return fs
        .readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  realpath(p: string): string {
    const abs = this.inside(p);
    if (abs === undefined) return p;
    try {
      const real = toPosix(fs.realpathSync.native(abs));
      return this.inside(real) ?? p;
    } catch {
      return p;
    }
  }
}
