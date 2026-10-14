import type { FsReader } from "./reader.js";
import { resolveGitDir } from "./git.js";

/** What git tracks: file paths, plus directory prefixes from a sparse index. */
export interface TrackedPaths {
  readonly files: ReadonlySet<string>;
  /** Directories (with a trailing slash) that a sparse index collapses; everything under them is tracked. */
  readonly sparseDirs: readonly string[];
}

/** Reads the offset-encoded varint git uses for v4 path compression. */
function readVarint(buf: Buffer, at: number): { value: number; next: number } {
  let byte = buf[at] ?? 0;
  let value = byte & 0x7f;
  let i = at + 1;
  while (byte & 0x80) {
    byte = buf[i] ?? 0;
    value = ((value + 1) << 7) | (byte & 0x7f);
    i++;
  }
  return { value, next: i };
}

/**
 * Parses the paths out of a git index file (format versions 2, 3 and 4, per
 * https://git-scm.com/docs/index-format). Pure: bytes in, paths out. Returns
 * undefined for anything it does not recognize, so callers fall back to plain
 * ignore rules rather than guessing.
 */
export function parseIndexPaths(
  buf: Buffer,
  hashBytes: 20 | 32,
): TrackedPaths | undefined {
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "DIRC")
    return undefined;
  const version = buf.readUInt32BE(4);
  if (version < 2 || version > 4) return undefined;
  const count = buf.readUInt32BE(8);
  const files = new Set<string>();
  const sparseDirs: string[] = [];
  let at = 12;
  let previous: Buffer = Buffer.alloc(0);
  for (let n = 0; n < count; n++) {
    const start = at;
    const fixed = 40 + hashBytes; // stat data, then the object id
    if (start + fixed + 2 > buf.length) return undefined;
    const flags = buf.readUInt16BE(start + fixed);
    let nameAt = start + fixed + 2;
    if (version >= 3 && flags & 0x4000) nameAt += 2; // extended flags
    let name: Buffer;
    if (version === 4) {
      const { value: strip, next } = readVarint(buf, nameAt);
      const end = buf.indexOf(0, next);
      if (end === -1 || strip > previous.length) return undefined;
      name = Buffer.concat([
        previous.subarray(0, previous.length - strip),
        buf.subarray(next, end),
      ]);
      at = end + 1;
    } else {
      const end = buf.indexOf(0, nameAt);
      if (end === -1) return undefined;
      name = buf.subarray(nameAt, end);
      // entries are NUL-padded to a multiple of 8 bytes
      at = start + ((nameAt - start + name.length + 8) & ~7);
    }
    previous = name;
    const path = name.toString("utf8");
    if (path.endsWith("/")) sparseDirs.push(path);
    else files.add(path);
  }
  return { files, sparseDirs };
}

/**
 * The paths git tracks in the repository at `root`, read from `.git/index` as
 * plain bytes (no git process, so no repo-local config can run). Undefined
 * outside a repository, for an index outside the root, or for one this parser
 * does not understand.
 */
export function readTrackedPaths(
  reader: FsReader,
  root: string,
): TrackedPaths | undefined {
  const gitDir = resolveGitDir(reader, root);
  if (gitDir === undefined) return undefined;
  const bytes = reader.readBytes(`${gitDir}/index`);
  if (bytes === undefined) return undefined;
  const config = reader.readFile(`${gitDir}/config`) ?? "";
  const sha256 = /^\s*objectformat\s*=\s*sha256\s*$/im.test(config);
  try {
    return parseIndexPaths(bytes, sha256 ? 32 : 20);
  } catch {
    return undefined; // truncated or malformed
  }
}
