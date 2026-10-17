import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/*
 * Consent to send a project's content to a provider (ADR-016), given once
 * per project and provider in main's own dialog and kept in Epoch's data
 * directory, never in the project.
 */

const ConsentFile = z.object({
  version: z.literal(1),
  granted: z.array(z.object({ root: z.string(), provider: z.string() })),
});
type ConsentFile = z.infer<typeof ConsentFile>;

export class ConsentStore {
  private readonly file: string;
  private data: ConsentFile;

  constructor(file: string) {
    this.file = file;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      raw = undefined;
    }
    const parsed = ConsentFile.safeParse(raw);
    this.data = parsed.success ? parsed.data : { version: 1, granted: [] };
  }

  has(root: string, provider: string): boolean {
    return this.data.granted.some(
      (g) => g.root === root && g.provider === provider,
    );
  }

  grant(root: string, provider: string): void {
    if (this.has(root, provider)) return;
    this.data.granted.push({ root, provider });
    this.save();
  }

  /** Forgets every consent given for a project. */
  revoke(root: string): void {
    this.data.granted = this.data.granted.filter((g) => g.root !== root);
    this.save();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
