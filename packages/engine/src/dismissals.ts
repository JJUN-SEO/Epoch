import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { resolveDataDir } from "@epoch-dev/core";

/*
 * Dismissed findings (CLAUDE.md "Alerts and review"): stored per project in
 * Epoch's own data directory, keyed by finding id, never in the project and
 * never in the cache (the cache is safe to delete; this is not). One JSON
 * file per project, owner-only, written atomically. The app's main process
 * and the CLI share it; it imports nothing heavier than node:fs and core.
 */

const POSIX = process.platform !== "win32";
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Finding ids are hashes; anything else is refused. */
export const DismissalId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const DismissalNote = z.string().max(1000);

const Entry = z.strictObject({
  at: z.iso.datetime(),
  note: DismissalNote.optional(),
});
const DismissalFile = z.strictObject({
  version: z.literal(1),
  /** The project folder, for people reading the file; lookups use the file name. */
  root: z.string(),
  dismissals: z.record(DismissalId, Entry),
});

export interface Dismissal {
  readonly id: string;
  readonly at: string;
  readonly note?: string;
}

/** The default data directory for this user and OS (EPOCH_DATA_DIR wins). */
export function defaultDataDir(): string {
  return resolveDataDir({
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
  });
}

export class DismissalStore {
  private readonly file: string;
  private readonly root: string;
  private entries: Map<string, z.infer<typeof Entry>>;

  private constructor(file: string, root: string) {
    this.file = file;
    this.root = root;
    this.entries = this.read();
  }

  /** The store for a project folder (absolute), in `dataDir` (default: the user's data directory). */
  static forProject(
    root: string,
    dataDir: string = defaultDataDir(),
  ): DismissalStore {
    const key = createHash("sha256")
      .update(path.resolve(root))
      .digest("hex")
      .slice(0, 32);
    return new DismissalStore(
      path.join(dataDir, "dismissals", `${key}.json`),
      path.resolve(root),
    );
  }

  /** Where the file lives (for Settings and tests). */
  get location(): string {
    return this.file;
  }

  private read(): Map<string, z.infer<typeof Entry>> {
    let text: string;
    try {
      if (fs.statSync(this.file).size > MAX_FILE_BYTES) return new Map();
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return new Map(); // none yet
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const result = DismissalFile.safeParse(parsed);
    if (!result.success) {
      // Keep the unreadable file aside rather than overwrite it on the next write.
      try {
        fs.renameSync(this.file, `${this.file}.unreadable`);
      } catch {
        // best effort
      }
      return new Map();
    }
    return new Map(Object.entries(result.data.dismissals));
  }

  private write(): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (POSIX) fs.chmodSync(dir, 0o700);
    const body: z.infer<typeof DismissalFile> = {
      version: 1,
      root: this.root,
      dismissals: Object.fromEntries(
        [...this.entries].sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
    };
    const tmp = `${this.file}.${String(process.pid)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(tmp, this.file);
    if (POSIX) fs.chmodSync(this.file, 0o600);
  }

  /** Re-reads the file (another process, e.g. the CLI, may have changed it). */
  reload(): void {
    this.entries = this.read();
  }

  ids(): Set<string> {
    return new Set(this.entries.keys());
  }

  list(): Dismissal[] {
    return [...this.entries]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([id, e]) => ({
        id,
        at: e.at,
        ...(e.note !== undefined ? { note: e.note } : {}),
      }));
  }

  dismiss(id: string, note?: string, at: Date = new Date()): void {
    const valid = DismissalId.parse(id);
    const text =
      note === undefined || note.trim() === ""
        ? undefined
        : DismissalNote.parse(note);
    this.reload();
    this.entries.set(valid, {
      at: at.toISOString(),
      ...(text !== undefined ? { note: text } : {}),
    });
    this.write();
  }

  undismiss(id: string): void {
    const valid = DismissalId.parse(id);
    this.reload();
    if (this.entries.delete(valid)) this.write();
  }
}
