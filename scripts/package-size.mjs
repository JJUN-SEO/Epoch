// Measures a packaged Epoch app: what each part weighs, and the installers.
//
// Usage: node scripts/package-size.mjs <unpacked app> [--installers <dir>]
//          [--label <name>] [--out <file.md>]
//
// <unpacked app> is electron-builder's output for one OS: release/linux-unpacked,
// release/win-unpacked or release/mac-arm64/Epoch.app. The report is a markdown
// table (sizes in MB = 1,000,000 bytes, as on disk, not as allocated): the
// Electron runtime, app.asar by package (read from the archive's own header),
// app.asar.unpacked by package, and the bundled embedding model. With
// --installers, the installer files in that directory are listed too.
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Files that are installers (matching packages/app/electron-builder.yml). */
const INSTALLER = /\.(dmg|exe|AppImage|deb)$/;

export function megabytes(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/** Total size of the regular files under `dir` (symlinks are not followed). */
export function sizeOf(dir) {
  const stat = fs.lstatSync(dir);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir))
    total += sizeOf(path.join(dir, entry));
  return total;
}

/**
 * The JSON header of an asar archive: after a 16-byte prefix (two pickle
 * lengths and the string length at offset 12), the file tree as JSON.
 */
export function readAsarHeader(file) {
  const fd = fs.openSync(file, "r");
  try {
    const prefix = Buffer.alloc(16);
    fs.readSync(fd, prefix, 0, 16, 0);
    const length = prefix.readUInt32LE(12);
    const json = Buffer.alloc(length);
    fs.readSync(fd, json, 0, length, 16);
    return JSON.parse(json.toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

/** Every file in an asar header as [path, size, unpacked]. */
export function* asarFiles(node, prefix = "") {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix === "" ? name : `${prefix}/${name}`;
    if (child.files) yield* asarFiles(child, p);
    else if (typeof child.size === "number")
      yield [p, child.size, child.unpacked === true];
  }
}

/** The package a path inside the app belongs to ("Epoch's code" for out/). */
export function packageOf(p) {
  const parts = p.split("/");
  const at = parts.lastIndexOf("node_modules");
  if (at === -1) return parts[0] === "out" ? "Epoch's code" : parts[0];
  const name = parts[at + 1] ?? "";
  return name.startsWith("@") ? `${name}/${parts[at + 2]}` : name;
}

function addTo(map, key, bytes) {
  map.set(key, (map.get(key) ?? 0) + bytes);
}

/** "a 1.2 MB, b 0.3 MB" for the largest entries. */
function largest(map, count = 4) {
  return [...map]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([k, v]) => `${k} ${megabytes(v)}`)
    .join(", ");
}

/** Where app.asar and the bundled model live in an unpacked app. */
export function resourcesOf(app) {
  return app.endsWith(".app")
    ? path.join(app, "Contents", "Resources")
    : path.join(app, "resources");
}

/** Measures one unpacked app; returns the table rows and the total. */
export function measure(app) {
  const resources = resourcesOf(app);
  const asar = path.join(resources, "app.asar");
  const unpacked = path.join(resources, "app.asar.unpacked");
  const model = path.join(resources, "model");
  const total = sizeOf(app);

  const inAsar = new Map();
  for (const [p, size, isUnpacked] of asarFiles(readAsarHeader(asar)))
    if (!isUnpacked) addTo(inAsar, packageOf(p), size);
  const asarSize = fs.statSync(asar).size;

  const outOfAsar = new Map();
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, p);
      else if (entry.isFile()) addTo(outOfAsar, packageOf(p), sizeOf(abs));
    }
  };
  const unpackedSize = fs.existsSync(unpacked) ? sizeOf(unpacked) : 0;
  if (unpackedSize > 0) walk(unpacked, "");
  const modelSize = fs.existsSync(model) ? sizeOf(model) : 0;

  const runtime = total - asarSize - unpackedSize - modelSize;
  const runtimeParts = new Map();
  const locales = app.endsWith(".app") ? undefined : path.join(app, "locales");
  if (locales && fs.existsSync(locales))
    runtimeParts.set("locales/", sizeOf(locales));
  for (const exe of ["epoch", "Epoch.exe"]) {
    const p = path.join(app, exe);
    if (fs.existsSync(p)) runtimeParts.set(`the ${exe} binary`, sizeOf(p));
  }
  const frameworks = path.join(app, "Contents", "Frameworks");
  if (fs.existsSync(frameworks))
    runtimeParts.set("Frameworks/", sizeOf(frameworks));

  return {
    total,
    rows: [
      ["Electron runtime", runtime, largest(runtimeParts)],
      ["`app.asar`", asarSize, largest(inAsar)],
      ["`app.asar.unpacked`", unpackedSize, largest(outOfAsar)],
      ["Embedding model", modelSize, "all-MiniLM-L6-v2 (ADR-008)"],
    ],
  };
}

/** The installer files in `dir`, by name. */
export function installers(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => INSTALLER.test(f))
    .sort()
    .map((f) => [f, fs.statSync(path.join(dir, f)).size]);
}

export function report(app, { label, installersDir } = {}) {
  const { total, rows } = measure(app);
  const lines = [
    `### ${label ?? path.basename(app)}`,
    "",
    `**${megabytes(total)} unpacked**`,
    "",
    "| Part | Size | Largest |",
    "| --- | --- | --- |",
    ...rows.map(
      ([part, size, what]) => `| ${part} | ${megabytes(size)} | ${what} |`,
    ),
  ];
  if (installersDir) {
    lines.push("", "| Installer | Size |", "| --- | --- |");
    for (const [name, size] of installers(installersDir))
      lines.push(`| \`${name}\` | ${megabytes(size)} |`);
  }
  return `${lines.join("\n")}\n`;
}

function main(argv) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const [value] = args.splice(i, 2).slice(1);
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };
  const out = take("--out");
  const label = take("--label");
  const installersDir = take("--installers");
  const [app] = args;
  if (app === undefined || args.length > 1)
    throw new Error(
      "Usage: package-size.mjs <unpacked app> [--installers <dir>] [--label <name>] [--out <file.md>]",
    );
  const text = report(app, { label, installersDir });
  if (out) fs.writeFileSync(out, text);
  process.stdout.write(text);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2));
