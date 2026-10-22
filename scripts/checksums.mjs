// Writes SHA-256 checksums of one OS's installers, in the format
// `sha256sum -c` reads ("<hex>  <name>", one per line).
//
// Usage: node scripts/checksums.mjs <dir> --os <darwin|win32|linux> [--out <file>]
// The installers are packages/app/installers.json's names for that OS; a
// missing one fails the script, so a release can never lack an installer
// silently. Without --out the list is printed.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function installerNames(os) {
  const names = JSON.parse(
    fs.readFileSync(path.join(root, "packages/app/installers.json"), "utf8"),
  )[os];
  if (!Array.isArray(names))
    throw new Error(`unknown OS ${JSON.stringify(os)}`);
  return names;
}

export function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** The checksum lines for `names` in `dir`; throws naming any missing file. */
export function checksums(dir, names) {
  const missing = names.filter((n) => !fs.existsSync(path.join(dir, n)));
  if (missing.length > 0)
    throw new Error(`missing installer(s) in ${dir}: ${missing.join(", ")}`);
  return names.map((n) => `${sha256(path.join(dir, n))}  ${n}\n`).join("");
}

function main(argv) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const value = args[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    args.splice(i, 2);
    return value;
  };
  const os = take("--os");
  const out = take("--out");
  const [dir] = args;
  if (dir === undefined || os === undefined || args.length > 1) {
    process.stderr.write(
      "Usage: checksums.mjs <dir> --os <darwin|win32|linux> [--out <file>]\n",
    );
    return 1;
  }
  const text = checksums(dir, installerNames(os));
  if (out) fs.writeFileSync(out, text);
  else process.stdout.write(text);
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main(process.argv.slice(2));
