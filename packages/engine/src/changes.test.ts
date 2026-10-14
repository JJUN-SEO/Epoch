import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoIndex } from "@epoch-dev/core";
import { RACY_MARGIN_NS, scanChanges } from "./changes.js";
import { toPosix } from "./discover.js";
import { FsReader } from "./reader.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-changes-"));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files))
    fs.writeFileSync(path.join(dir, rel), text);
  const root = toPosix(path.resolve(dir));
  return { dir, root, reader: new FsReader(root) };
}

/** A previous index whose scan started `offsetNs` after the files' last change. */
function previousIndex(
  root: string,
  scan: ReturnType<typeof scanChanges>,
  offsetNs: bigint,
): RepoIndex {
  const entries = [...scan.files.values()].map((s) => s.entry);
  const latest = entries.reduce((m, e) => {
    const t =
      BigInt(e.mtimeNs) > BigInt(e.ctimeNs)
        ? BigInt(e.mtimeNs)
        : BigInt(e.ctimeNs);
    return t > m ? t : m;
  }, 0n);
  return {
    root,
    lastCommit: null,
    scanStartedNs: String(latest + offsetNs),
    files: entries,
  };
}

describe("scanChanges", () => {
  it("reads and hashes everything without a previous manifest", () => {
    const { root, reader } = project({ "a.ts": "a", "b.ts": "bb" });
    const scan = scanChanges(reader, root, ["a.ts", "b.ts"], undefined);
    expect(scan.rehashed).toBe(2);
    expect(scan.files.get("a.ts")?.bytes?.toString()).toBe("a");
    expect(scan.files.get("b.ts")?.entry.size).toBe(2);
  });

  it("trusts files unchanged since well before the previous scan, without reading them", () => {
    const { root, reader } = project({ "a.ts": "a", "b.ts": "bb" });
    const first = scanChanges(reader, root, ["a.ts", "b.ts"], undefined);
    const prev = previousIndex(root, first, RACY_MARGIN_NS + 1_000_000_000n);
    const second = scanChanges(reader, root, ["a.ts", "b.ts"], prev);
    expect(second.rehashed).toBe(0);
    expect(second.files.get("a.ts")?.bytes).toBeUndefined();
    expect(second.files.get("a.ts")?.entry).toEqual(
      first.files.get("a.ts")?.entry,
    );
  });

  it("re-hashes files changed within the racy margin of the previous scan", () => {
    const { root, reader } = project({ "a.ts": "a" });
    const first = scanChanges(reader, root, ["a.ts"], undefined);
    const prev = previousIndex(root, first, RACY_MARGIN_NS - 1n);
    expect(scanChanges(reader, root, ["a.ts"], prev).rehashed).toBe(1);
  });

  it("re-hashes edited files, including same-size edits that restore the mtime", () => {
    const { dir, root, reader } = project({ "a.ts": "aaaa", "b.ts": "b" });
    const first = scanChanges(reader, root, ["a.ts", "b.ts"], undefined);
    const prev = previousIndex(root, first, RACY_MARGIN_NS + 1_000_000_000n);
    const file = path.join(dir, "a.ts");
    const { atime, mtime } = fs.statSync(file);
    fs.writeFileSync(file, "zzzz"); // same size
    fs.utimesSync(file, atime, mtime); // mtime restored, ctime moves on
    const second = scanChanges(reader, root, ["a.ts", "b.ts"], prev);
    expect(second.rehashed).toBe(1);
    expect(second.files.get("a.ts")?.entry.contentHash).not.toBe(
      first.files.get("a.ts")?.entry.contentHash,
    );
  });

  it("re-reads forced files and reports unreadable ones", () => {
    const { root, reader } = project({ "a.ts": "a" });
    const first = scanChanges(reader, root, ["a.ts"], undefined);
    const prev = previousIndex(root, first, RACY_MARGIN_NS + 1_000_000_000n);
    const forced = scanChanges(
      reader,
      root,
      ["a.ts", "gone.ts"],
      prev,
      new Set(["a.ts"]),
    );
    expect(forced.rehashed).toBe(1);
    expect(forced.unreadable).toEqual(["gone.ts"]);
  });
});
