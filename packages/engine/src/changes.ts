import type { ManifestEntry, RepoIndex } from "@epoch-dev/core";
import { sha256 } from "./cache/keys.js";
import type { FsReader } from "./reader.js";

/**
 * Files modified this close to (or after) the start of the previous scan are
 * always re-hashed, even if size and timestamps match: a write landing during
 * the scan could share a timestamp tick with the bytes we read. 2 s covers the
 * coarsest common mtime resolution (FAT); git calls this the racy-clean case.
 */
export const RACY_MARGIN_NS = 2_000_000_000n;

export interface FileState {
  readonly entry: ManifestEntry;
  /** The bytes, when this run had to read the file. */
  readonly bytes?: Buffer;
}

export interface ChangeScan {
  /** Per repo-relative path; unreadable files are absent. */
  readonly files: Map<string, FileState>;
  readonly unreadable: string[];
  /** How many files were read and hashed because the manifest could not vouch for them. */
  readonly rehashed: number;
}

/** Wall-clock time in ns (millisecond resolution), as stored in RepoIndex. */
export const nowNs = (): bigint => BigInt(Date.now()) * 1_000_000n;

/**
 * Change detection (ADR-004): a file whose size, mtime and ctime match the
 * previous manifest, and which was last changed well before the previous scan
 * started, keeps its stored content hash without being read. Every other file
 * is read and hashed. Works the same in git and non-git folders, and runs no
 * process. `force` names files to re-read regardless (from --since).
 */
export function scanChanges(
  reader: FsReader,
  root: string,
  rels: readonly string[],
  previous: RepoIndex | undefined,
  force: ReadonlySet<string> = new Set(),
): ChangeScan {
  const prior = new Map(previous?.files.map((f) => [f.path, f]));
  const prevStart =
    previous === undefined ? undefined : BigInt(previous.scanStartedNs);
  const files = new Map<string, FileState>();
  const unreadable: string[] = [];
  let rehashed = 0;
  for (const rel of rels) {
    const abs = `${root}/${rel}`;
    const st = reader.statFile(abs);
    if (!st) {
      unreadable.push(rel);
      continue;
    }
    const mtimeNs = String(st.mtimeNs);
    const ctimeNs = String(st.ctimeNs);
    const old = prior.get(rel);
    const changedAt = st.mtimeNs > st.ctimeNs ? st.mtimeNs : st.ctimeNs;
    const trusted =
      old !== undefined &&
      prevStart !== undefined &&
      !force.has(rel) &&
      old.size === st.size &&
      old.mtimeNs === mtimeNs &&
      old.ctimeNs === ctimeNs &&
      changedAt + RACY_MARGIN_NS < prevStart;
    if (trusted) {
      files.set(rel, { entry: old });
      continue;
    }
    const bytes = reader.readBytes(abs);
    if (bytes === undefined) {
      unreadable.push(rel);
      continue;
    }
    rehashed++;
    files.set(rel, {
      entry: {
        path: rel,
        size: bytes.length,
        mtimeNs,
        ctimeNs,
        contentHash: sha256(bytes),
      },
      bytes,
    });
  }
  return { files, unreadable, rehashed };
}
