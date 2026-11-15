// Builds the npm package of the CLI, @epoch-dev/cli (ADR-018).
//
// The workspace packages are private, so the published package carries them
// bundled (packages/cli/vite.npm.config.ts) and declares only third-party
// packages, with the exact versions the workspace pins.
//
// Usage: node scripts/pack-cli.mjs [--pack <folder>]
// Writes packages/cli/npm (package.json, dist, README.md, LICENSE). With
// --pack it also runs `npm pack` there and prints the tarball's path.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { appVersion, isReleaseVersion } from "./release-version.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliDir = path.join(root, "packages/cli");

/**
 * Needed only for similarity hints from a local embedding model, which the
 * npm package does not carry: onnxruntime-node alone is about 290 MB. They
 * are loaded lazily, and without them Epoch reports the model unavailable.
 */
export const LEFT_OUT = new Set([
  "onnxruntime-node",
  "@huggingface/tokenizers",
]);

/**
 * The third-party dependencies of `name` and of every workspace package it
 * depends on, with `catalog:` versions resolved. Throws when two packages
 * pin different versions of one dependency.
 */
export function thirdPartyDependencies(name, manifests, catalog) {
  const out = new Map();
  const seen = new Set();
  const visit = (pkg) => {
    if (seen.has(pkg)) return;
    seen.add(pkg);
    const manifest = manifests.get(pkg);
    if (!manifest) throw new Error(`unknown workspace package ${pkg}`);
    for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
      if (range.startsWith("workspace:")) {
        visit(dep);
        continue;
      }
      if (LEFT_OUT.has(dep)) continue;
      const version = range === "catalog:" ? catalog[dep] : range;
      if (typeof version !== "string") {
        throw new Error(`${pkg}: no catalog version for ${dep}`);
      }
      const known = out.get(dep);
      if (known !== undefined && known !== version) {
        throw new Error(
          `${dep} is pinned twice: ${known} and ${version} (in ${pkg})`,
        );
      }
      out.set(dep, version);
    }
  };
  visit(name);
  return Object.fromEntries(
    [...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** The manifest npm publishes. */
export function publishedManifest(cli, version, dependencies) {
  if (!isReleaseVersion(version)) {
    throw new Error(
      `version ${JSON.stringify(version)} is not MAJOR.MINOR.PATCH`,
    );
  }
  return {
    name: cli.name,
    version,
    description:
      "Epoch's command line: a codebase's dependency graph, blast radius, risk tiers and likely-dead feature candidates, on your machine. Also a read-only MCP server for AI coding agents.",
    license: cli.license,
    type: "module",
    bin: { epoch: "dist/bin.js" },
    files: ["dist"],
    engines: cli.engines ?? { node: "^24.0.0 || >=26.0.0" },
    homepage: "https://github.com/JJUN-SEO/Epoch#readme",
    repository: {
      type: "git",
      url: "git+https://github.com/JJUN-SEO/Epoch.git",
      directory: "packages/cli",
    },
    bugs: { url: "https://github.com/JJUN-SEO/Epoch/issues" },
    keywords: [
      "dependency-graph",
      "blast-radius",
      "static-analysis",
      "dead-code",
      "mcp",
      "typescript",
      "python",
      "go",
    ],
    dependencies,
    optionalDependencies: cli.optionalDependencies ?? {},
    publishConfig: { access: "public" },
  };
}

function workspaceManifests() {
  const manifests = new Map();
  for (const group of ["packages", "packages/adapters"]) {
    for (const entry of fs.readdirSync(path.join(root, group))) {
      const file = path.join(root, group, entry, "package.json");
      if (!fs.existsSync(file)) continue;
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      manifests.set(manifest.name, manifest);
    }
  }
  return manifests;
}

function main(args) {
  const packAt = args[0] === "--pack" ? args[1] : undefined;
  if (args.length > 0 && packAt === undefined) {
    process.stderr.write("Usage: pack-cli.mjs [--pack <folder>]\n");
    return 1;
  }
  const manifests = workspaceManifests();
  const cli = manifests.get("@epoch-dev/cli");
  const { catalog } = parse(
    fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"),
  );
  const rootManifest = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const out = path.join(cliDir, "npm");
  fs.rmSync(out, { recursive: true, force: true });
  // pnpm, not npx: the workspace's own Vite, at its pinned version.
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@epoch-dev/cli",
      "exec",
      "vite",
      "build",
      "--config",
      "vite.npm.config.ts",
    ],
    {
      cwd: root,
      stdio: ["ignore", "inherit", "inherit"],
      shell: process.platform === "win32",
    },
  );
  const manifest = publishedManifest(
    { ...cli, engines: rootManifest.engines },
    appVersion(),
    thirdPartyDependencies("@epoch-dev/cli", manifests, catalog),
  );
  fs.writeFileSync(
    path.join(out, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  fs.copyFileSync(path.join(cliDir, "README.md"), path.join(out, "README.md"));
  fs.copyFileSync(path.join(root, "LICENSE"), path.join(out, "LICENSE"));
  process.stdout.write(`${manifest.name}@${manifest.version} in ${out}\n`);
  if (packAt !== undefined) {
    const dest = path.resolve(packAt);
    fs.mkdirSync(dest, { recursive: true });
    const name = execFileSync(
      "npm",
      ["pack", "--silent", "--pack-destination", dest],
      { cwd: out, encoding: "utf8", shell: process.platform === "win32" },
    ).trim();
    process.stdout.write(`${path.join(dest, name)}\n`);
  }
  return 0;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main(process.argv.slice(2));
