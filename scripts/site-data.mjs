// Precomputes the static demo's graphs (CLAUDE.md "Distribution": graphs and
// findings of public repositories, precomputed; the site has no backend and
// no source code). For each repository in apps/site/data/repos.json:
//
// 1. a full clone in .cache/site-repos/<id> (gitignored; full history, since
//    churn, risk tiers and stale-flag findings read git), checked out at the
//    pinned commit, which must be what HEAD resolves to;
// 2. `epoch --offline analyze <repo> --json`, the built CLI, with no
//    embedding model (so the result is the same on every machine), and its
//    stdout written byte for byte to apps/site/data/<id>.graph.json. With
//    the repository's coverage report (apps/site/data/test-coverage/, made once
//    from its own tests; see the README there), also `--coverage <report>`;
// 3. <id>.meta.json (where it came from and how it was made) and
//    <id>.LICENSE.txt (the repository's license at that commit).
//
// Usage: node scripts/site-data.mjs [<id>...]   (pnpm site:data builds the CLI first)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, "apps/site/data");
const cacheDir = path.join(root, ".cache/site-repos");
const cli = path.join(root, "packages/cli/dist/bin.js");

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "advice.detachedHead=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${r.stderr}`);
  return r.stdout.trim();
}

/** The first line of a license that names the copyright holder. */
export function copyrightLine(license) {
  return (
    license
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /^copyright\b/i.test(l)) ?? ""
  );
}

/** A clone of `repo` at its pinned commit, made or reused. */
function checkout(repo) {
  const dir = path.join(cacheDir, repo.id);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(cacheDir, { recursive: true });
    git(cacheDir, "clone", "--quiet", "--no-checkout", repo.url, repo.id);
  }
  try {
    git(dir, "cat-file", "-e", `${repo.commit}^{commit}`);
  } catch {
    git(dir, "fetch", "--quiet", "origin", repo.commit);
  }
  git(dir, "checkout", "--quiet", "--force", "--detach", repo.commit);
  const head = git(dir, "rev-parse", "HEAD");
  if (head !== repo.commit)
    throw new Error(
      `${repo.id}: HEAD is ${head}, not the pinned ${repo.commit}`,
    );
  if (git(dir, "status", "--porcelain") !== "")
    throw new Error(`${repo.id}: the checkout has local changes`);
  return dir;
}

function analyze(dir, coverage) {
  // A throwaway cache: the output does not depend on it, and the user's own
  // cache stays untouched.
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-site-data-"));
  try {
    const r = spawnSync(
      process.execPath,
      [
        cli,
        "--offline",
        "analyze",
        dir,
        "--json",
        ...(coverage === undefined ? [] : ["--coverage", coverage]),
      ],
      {
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
        env: { ...process.env, EPOCH_CACHE_DIR: cache },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    if (r.status !== 0) throw new Error(`epoch analyze ${dir} failed`);
    return r.stdout;
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
}

function main(ids) {
  const repos = JSON.parse(
    fs.readFileSync(path.join(dataDir, "repos.json"), "utf8"),
  );
  const unknown = ids.filter((id) => !repos.some((r) => r.id === id));
  if (unknown.length > 0)
    throw new Error(`unknown repos: ${unknown.join(", ")}`);
  if (!fs.existsSync(cli))
    throw new Error("build the CLI first (pnpm site:data does)");
  const epochCommit = git(root, "rev-parse", "HEAD");
  for (const repo of repos) {
    if (ids.length > 0 && !ids.includes(repo.id)) continue;
    const dir = checkout(repo);
    process.stderr.write(`site-data: ${repo.id} at ${repo.commit}\n`);
    const coverage =
      repo.coverage === undefined
        ? undefined
        : path.join(dataDir, repo.coverage.report);
    const graph = analyze(dir, coverage);
    const parsed = JSON.parse(graph);
    fs.writeFileSync(path.join(dataDir, `${repo.id}.graph.json`), graph);
    const license = git(dir, "show", `${repo.commit}:${repo.licenseFile}`);
    fs.writeFileSync(
      path.join(dataDir, `${repo.id}.LICENSE.txt`),
      `${license}\n`,
    );
    const meta = {
      id: repo.id,
      name: repo.name,
      language: repo.language,
      url: repo.url,
      commit: repo.commit,
      commitDate: git(dir, "log", "-1", "--format=%cI", repo.commit),
      license: repo.license,
      copyright: copyrightLine(license),
      licenseFile: `${repo.id}.LICENSE.txt`,
      madeWith: {
        epochCommit,
        command: `epoch --offline analyze <repository> --json${repo.coverage === undefined ? "" : ` --coverage ${repo.coverage.report}`}`,
        ...(repo.coverage === undefined ? {} : { coverage: repo.coverage }),
      },
      counts: {
        nodes: parsed.nodes.length,
        edges: parsed.edges.length,
        findings: parsed.findings.length,
        covered: parsed.nodes.filter((n) => n.metrics.coverage !== undefined)
          .length,
      },
    };
    fs.writeFileSync(
      path.join(dataDir, `${repo.id}.meta.json`),
      `${JSON.stringify(meta, null, 2)}\n`,
    );
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2));
