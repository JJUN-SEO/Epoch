import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const MAX_RECENT = 10;

const RecentFile = z.object({
  version: z.literal(1),
  projects: z.array(z.string().min(1).max(4096)).max(100),
});

/** Moves `folder` to the front, without duplicates, keeping at most MAX_RECENT. */
export function addRecent(
  list: readonly string[],
  folder: string,
): readonly string[] {
  return [folder, ...list.filter((f) => f !== folder)].slice(0, MAX_RECENT);
}

/**
 * The recent-projects list, kept in Epoch's own app data (never in a
 * project). It is written only by main, from folders the user granted.
 */
export class RecentProjects {
  private readonly file: string;
  private list: readonly string[];

  constructor(file: string) {
    this.file = file;
    this.list = RecentProjects.read(file);
  }

  private static read(file: string): readonly string[] {
    try {
      const parsed = RecentFile.safeParse(
        JSON.parse(fs.readFileSync(file, "utf8")),
      );
      return parsed.success
        ? parsed.data.projects
            .filter((p) => path.isAbsolute(p))
            .slice(0, MAX_RECENT)
        : [];
    } catch {
      return [];
    }
  }

  get projects(): readonly string[] {
    return this.list;
  }

  add(folder: string): void {
    this.list = addRecent(this.list, folder);
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, projects: this.list }, null, 2),
      { mode: 0o600 },
    );
    fs.renameSync(tmp, this.file);
  }
}
