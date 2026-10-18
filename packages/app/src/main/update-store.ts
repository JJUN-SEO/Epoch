import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseVersion } from "./version";

/** What the update check remembers between runs (ADR-018). */
export interface UpdateRecord {
  /** When the release host was last asked (ms since the epoch), 0 if never. */
  readonly lastCheckedAt: number;
  /** The latest release's tag it reported, if it was a release version. */
  readonly latest?: string;
}

const UpdateFile = z.object({
  version: z.literal(1),
  lastCheckedAt: z.number().int().nonnegative(),
  latest: z
    .string()
    .max(64)
    .refine((t) => parseVersion(t) !== undefined)
    .optional(),
});

/**
 * The update check's record, in Epoch's own data directory (owner-only file,
 * written atomically). A missing or damaged file reads as never checked.
 */
export class UpdateStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  read(): UpdateRecord {
    try {
      const parsed = UpdateFile.safeParse(
        JSON.parse(fs.readFileSync(this.file, "utf8")),
      );
      if (!parsed.success) return { lastCheckedAt: 0 };
      const { lastCheckedAt, latest } = parsed.data;
      return latest === undefined
        ? { lastCheckedAt }
        : { lastCheckedAt, latest };
    } catch {
      return { lastCheckedAt: 0 };
    }
  }

  write(record: UpdateRecord): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(
      tmp,
      `${JSON.stringify({ version: 1, ...record }, null, 2)}\n`,
      { mode: 0o600 },
    );
    fs.renameSync(tmp, this.file);
  }
}
