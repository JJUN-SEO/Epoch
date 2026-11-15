import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/*
 * The zero-network test (PLAN.md M7 acceptance): the built CLI runs a full
 * analysis and findings on a git repository, with the local embedding
 * model, under scripts/no-network.mjs, which logs every network attempt in
 * every thread. The canary proves the log catches attempts, in the main
 * thread and in a worker (the parse workers are threads). The query
 * commands and a whole agent session (ADR-021) run under it too.
 */

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const preload = pathToFileURL(path.join(repo, "scripts/no-network.mjs")).href;
const manifest = JSON.parse(
  fs.readFileSync(path.join(repo, "models/manifest.json"), "utf8"),
) as { default: string };
const realModel = path.join(repo, "models", manifest.default);
// The fetched model when present (CI fetches it), else the engine's tiny
// test model: the same runtime path.
const model = fs.existsSync(path.join(realModel, "model.onnx"))
  ? realModel
  : path.join(repo, "packages/engine/src/fixtures/tiny-embedder");

const temps: string[] = [];
const temp = (name: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `epoch-${name}-`));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function underTripwire(args: string[], env: Record<string, string> = {}) {
  const home = temp("no-network");
  const log = path.join(home, "network.log");
  fs.writeFileSync(log, "");
  const r = spawnSync(process.execPath, ["--import", preload, bin, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      EPOCH_CACHE_DIR: path.join(home, "cache"),
      EPOCH_DATA_DIR: path.join(home, "data"),
      EPOCH_NETWORK_LOG: log,
      ...env,
    },
  });
  const attempts = fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l !== "");
  return { status: r.status, stderr: r.stderr, attempts };
}

/** A copy of the monorepo fixture as a git repository with two commits. */
function gitProject(): string {
  const dir = temp("project");
  fs.cpSync(path.join(repo, "fixtures/typescript/monorepo"), dir, {
    recursive: true,
  });
  const git = (...a: string[]) =>
    execFileSync("git", a, {
      cwd: dir,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  fs.appendFileSync(path.join(dir, "package.json"), "\n");
  git("commit", "-q", "-am", "two");
  return dir;
}

// Each case starts the built CLI (and the embedding model) more than once.
const SPAWNS_MS = 120_000;

describe("zero network (the built CLI under the tripwire)", () => {
  it(
    "catches attempts in the main thread and in a worker: the canary",
    () => {
      const r = underTripwire(["cache", "stats"], {
        EPOCH_NETWORK_CANARY: "1",
      });
      expect(r.status).toBe(0);
      for (const name of ["net.connect", "dns.lookup", "fetch"]) {
        expect(r.attempts).toContain(`main ${name}`);
        expect(
          r.attempts.some(
            (a) => a.startsWith("worker ") && a.endsWith(` ${name}`),
          ),
        ).toBe(true);
      }
    },
    SPAWNS_MS,
  );

  it.each([[[]], [["--offline"]]])(
    "attempts nothing during a full analysis and findings run %j",
    (flags: string[]) => {
      const project = gitProject();
      for (const command of ["analyze", "findings"]) {
        const r = underTripwire([
          ...flags,
          command,
          project,
          "--embedding-model",
          model,
        ]);
        expect(r.stderr).not.toContain("epoch:");
        expect(r.status).toBe(0);
        expect(r.attempts).toEqual([]);
      }
    },
    SPAWNS_MS,
  );

  it(
    "attempts nothing during impact, path, explain and export",
    () => {
      const project = gitProject();
      for (const args of [
        ["impact", project, "--base", "HEAD~1", "--likely"],
        [
          "path",
          project,
          "apps/web/src/main.tsx",
          "packages/core/src/index.ts",
        ],
        ["explain", project, "apps/web/src/main.tsx"],
        ["export", project, "--format", "graphml"],
      ]) {
        const r = underTripwire(args);
        expect(r.stderr).not.toContain("epoch:");
        expect(r.status).toBe(0);
        expect(r.attempts).toEqual([]);
      }
    },
    SPAWNS_MS,
  );

  it(
    "attempts nothing during an agent session (epoch mcp)",
    async () => {
      const project = gitProject();
      const home = temp("no-network");
      const log = path.join(home, "network.log");
      fs.writeFileSync(log, "");
      const client = new Client({ name: "epoch-test", version: "0.0.0" });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ["--import", preload, bin, "mcp", project],
          stderr: "pipe",
          env: {
            ...(Object.fromEntries(
              Object.entries(process.env).filter(([, v]) => v !== undefined),
            ) as Record<string, string>),
            EPOCH_CACHE_DIR: path.join(home, "cache"),
            EPOCH_DATA_DIR: path.join(home, "data"),
            EPOCH_NETWORK_LOG: log,
          },
        }),
      );
      const { tools } = await client.listTools();
      const args: Record<string, Record<string, unknown>> = {
        find: { query: "main" },
        explain: { file: "apps/web/src/main.tsx" },
        blast_radius: { file: "packages/core/src/index.ts", likely: true },
        impact: { base: "HEAD~1", likely: true },
        path: {
          from: "apps/web/src/main.tsx",
          to: "packages/core/src/index.ts",
        },
      };
      for (const t of tools) {
        const r = await client.callTool({
          name: t.name,
          arguments: args[t.name] ?? {},
        });
        expect(r.isError, t.name).not.toBe(true);
      }
      await client.close();
      expect(tools).toHaveLength(8);
      expect(
        fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter((l) => l !== ""),
      ).toEqual([]);
    },
    SPAWNS_MS,
  );
});
