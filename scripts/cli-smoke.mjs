// Smoke test of the npm package of the CLI (ADR-018): installs the packed
// tarball in an empty folder, as a user would, and runs it from there.
//
// Usage: node scripts/cli-smoke.mjs <tarball>
//
// It checks the version, a small analysis, an analysis large enough to start
// the parse workers (which must find their entry inside the package), and
// one conversation with the agent server in plain JSON-RPC over stdio, with
// no MCP library on this side.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { appVersion } from "./release-version.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const win = process.platform === "win32";

/** One request to the agent server and its answer, by id. */
function converse(bin, args, env, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const answers = new Map();
    let buffer = "";
    let next = 0;
    const send = () => {
      const request = requests[next++];
      if (request === undefined) {
        child.stdin.end();
        return;
      }
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...request })}\n`);
      // A notification has no answer to wait for.
      if (request.id === undefined) send();
    };
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === "") continue;
        const message = JSON.parse(line);
        if (message.id !== undefined) {
          answers.set(message.id, message);
          send();
        }
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(answers);
      else reject(new Error(`epoch mcp exited with code ${String(code)}`));
    });
    send();
  });
}

async function main([tarball]) {
  if (tarball === undefined) {
    process.stderr.write("Usage: cli-smoke.mjs <tarball>\n");
    return 1;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-cli-smoke-"));
  try {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      '{ "name": "epoch-cli-smoke", "private": true }\n',
    );
    execFileSync(
      "npm",
      ["install", "--no-audit", "--no-fund", path.resolve(tarball)],
      { cwd: dir, stdio: "inherit", shell: win },
    );
    const bin = path.join(dir, "node_modules/@epoch-dev/cli/dist/bin.js");
    const env = {
      ...process.env,
      EPOCH_CACHE_DIR: path.join(dir, "cache"),
      EPOCH_DATA_DIR: path.join(dir, "data"),
    };
    const epoch = (...args) =>
      execFileSync(process.execPath, [bin, ...args], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 256 * 1024 * 1024,
      });

    assert.equal(epoch("--version").trim(), appVersion());

    const fixture = path.join(root, "fixtures/typescript/monorepo");
    const small = JSON.parse(epoch("analyze", fixture, "--json"));
    assert.ok(small.nodes.length > 5, "the fixture's graph has nodes");
    assert.ok(small.edges.length > 0, "the fixture's graph has edges");

    // Epoch's own repository: enough files for the parse workers to start.
    const large = JSON.parse(epoch("analyze", root, "--json", "--no-hints"));
    assert.ok(large.nodes.length > 300, "a repository-sized graph");

    const answers = await converse(bin, ["mcp", fixture], env, [
      {
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "epoch-cli-smoke", version: "0" },
        },
      },
      { method: "notifications/initialized" },
      { id: 2, method: "tools/list" },
      {
        id: 3,
        method: "tools/call",
        params: { name: "overview", arguments: {} },
      },
    ]);
    assert.equal(answers.get(1).result.serverInfo.name, "epoch");
    assert.equal(answers.get(1).result.serverInfo.version, appVersion());
    assert.equal(answers.get(2).result.tools.length, 8);
    const overview = JSON.parse(answers.get(3).result.content[0].text);
    assert.equal(overview.nodes, small.nodes.length);

    process.stdout.write(
      `cli-smoke: ${String(small.nodes.length)} and ${String(large.nodes.length)} nodes analyzed, agent server answered\n`,
    );
    return 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv.slice(2));
