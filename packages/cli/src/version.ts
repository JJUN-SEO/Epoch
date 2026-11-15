import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The CLI's version, from its own package.json, found upward from this
 * module: the build tree and the npm bundle lay the files out differently,
 * and the published manifest carries the release's version (ADR-018).
 */
export function cliVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(dir, "package.json"), "utf8"),
      ) as { name?: unknown; version?: unknown };
      if (pkg.name === "@epoch-dev/cli" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      // no manifest here; look one folder up
    }
    dir = path.dirname(dir);
  }
  return "0.0.0";
}
