import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { EXIT_ERROR, run } from "./run.js";

// Most tests here run a whole analysis: slow on a loaded Windows runner.
vi.setConfig({ testTimeout: 60_000 });

// A throwaway cache, never the user's; no key leaks in from the environment.
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-cli-scorer-"));
process.env.EPOCH_CACHE_DIR = cacheDir;
const savedKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});
afterAll(() => {
  if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

// Keys come from the environment here; the OS keychain is never asked.
const noKeychain = {
  get: () => Promise.resolve(undefined),
  set: () => Promise.reject(new Error("not in this test")),
  remove: () => Promise.resolve(false),
};

async function cli(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await run(
    argv,
    {
      stdout: { write: (s: string) => (stdout += s) },
      stderr: { write: (s: string) => (stderr += s) },
    },
    { keychain: noKeychain },
  );
  return { code, stdout, stderr };
}

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-cli-scorer-p-"));
  const files: Record<string, string> = {
    "src/pub.ts": 'export const EVENT = "user.created";\n',
    "src/sub.ts": 'export const ON = "user.created";\n',
    "src/other.ts": "export const other = 1;\n",
    "src/more.ts": "export const more = 2;\n",
    ".env": "SECRET=1\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("epoch --scorer", () => {
  it.each([
    [
      ["--scorer", "llm"],
      "needs your own Anthropic key: set ANTHROPIC_API_KEY",
    ],
    [["--scorer", "local"], "--scorer local needs --model"],
    [["--scorer", "jev"], "needs your own Jev key: set JEV_API_KEY"],
    [["--scorer", "gpt"], "--scorer must be heuristic, local, llm or jev"],
    [["--consent-send"], "apply to --scorer local, llm or jev"],
    [["--no-hints", "--scorer", "local"], "--no-hints cannot be combined"],
  ])("refuses %j before analyzing", async (flags, message) => {
    const dir = project();
    dirs.push(dir);
    const r = await cli("analyze", dir, ...flags);
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.stderr).toContain(message);
  });

  it("asks for a spend cap and prices before a paid scorer can run", async () => {
    const dir = project();
    dirs.push(dir);
    process.env.ANTHROPIC_API_KEY = "test-key-never-sent";
    const r = await cli("analyze", dir, "--scorer", "llm", "--max-spend", "1");
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.stderr).toContain("--price-in and --price-out");
  });

  it("prints exactly what would be sent, sends nothing without --consent-send, and never echoes the key", async () => {
    const dir = project();
    dirs.push(dir);
    process.env.ANTHROPIC_API_KEY = "test-key-never-sent";
    const r = await cli(
      "findings",
      dir,
      "--scorer",
      "llm",
      "--max-spend",
      "0.50",
      "--price-in",
      "1",
      "--price-out",
      "5",
    );
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.stderr).toContain(
      "Epoch would send data to Anthropic (model claude-haiku-5-5, with your key) (https://api.anthropic.com)",
    );
    expect(r.stderr).toContain("2 requests, one per pair of files");
    expect(r.stderr).toContain("src/pub.ts (");
    expect(r.stderr).toContain("src/sub.ts (");
    expect(r.stderr).toContain("Nothing has been sent");
    expect(r.stderr).toContain("$0.50 cap");
    expect(r.stderr + r.stdout).not.toContain("test-key-never-sent");
  });
});
