import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { RepoRelativePath } from "../shared/host-protocol";

/*
 * The coverage report a user chose for a project (ADR-020), kept in Epoch's
 * own app data, never in the project. Main picks the file in a native dialog
 * and keeps it only if it lies inside the project; the renderer never sends
 * a path. The host reads it through the root-confined reader like any other
 * project file.
 */

const MAX_PROJECTS = 1000;
const MAX_FILE_BYTES = 1024 * 1024;

const ChoicesFile = z.object({
  version: z.literal(1),
  /** Project folder (absolute) -> report (repo-relative). */
  reports: z.record(z.string().min(1).max(4096), RepoRelativePath),
});

/**
 * The report's path relative to `root` (a real folder path), forward
 * slashes, if the file's real location is inside it; undefined otherwise
 * (outside, a symlink out of it, missing, or the root itself).
 */
export function reportInside(root: string, file: string): string | undefined {
  let real: string;
  let realRoot: string;
  try {
    real = fs.realpathSync.native(file);
    realRoot = fs.realpathSync.native(root);
    if (!fs.statSync(real).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const rel = path.relative(realRoot, real);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel)
  )
    return undefined;
  const posix = rel.split(path.sep).join("/");
  return RepoRelativePath.safeParse(posix).success ? posix : undefined;
}

/** What choosing a coverage report in main's dialog came to. */
export type CoverageChoice =
  | { readonly state: "chosen"; readonly path: string }
  | { readonly state: "canceled" }
  | { readonly state: "outside-project" };

/** Where each project's chosen report is kept. */
export interface CoverageChoiceStore {
  get(root: string): string | undefined;
  set(root: string, report: string | undefined): void;
}

/** Each project's chosen coverage report, in one JSON file written only by main. */
export class CoverageChoices implements CoverageChoiceStore {
  private readonly file: string;
  private reports: Map<string, string>;

  constructor(file: string) {
    this.file = file;
    this.reports = CoverageChoices.read(file);
  }

  private static read(file: string): Map<string, string> {
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) return new Map();
      const parsed = ChoicesFile.safeParse(
        JSON.parse(fs.readFileSync(file, "utf8")),
      );
      return parsed.success
        ? new Map<string, string>(
            Object.entries(parsed.data.reports).filter(([root]) =>
              path.isAbsolute(root),
            ),
          )
        : new Map<string, string>();
    } catch {
      return new Map<string, string>(); // none yet, or unreadable: look for reports instead
    }
  }

  get(root: string): string | undefined {
    return this.reports.get(root);
  }

  /** Sets or (undefined) clears a project's report. */
  set(root: string, report: string | undefined): void {
    this.reports.delete(root);
    if (report !== undefined) this.reports.set(root, report);
    // The most recently set last; the oldest are dropped past the cap.
    while (this.reports.size > MAX_PROJECTS) {
      const oldest = this.reports.keys().next().value;
      if (oldest === undefined) break;
      this.reports.delete(oldest);
    }
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(
      tmp,
      JSON.stringify(
        { version: 1, reports: Object.fromEntries(this.reports) },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    fs.renameSync(tmp, this.file);
  }
}
