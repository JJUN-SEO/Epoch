import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import {
  KeychainUnavailable,
  authCommand,
  readKey,
  resolveKey,
  type AuthDeps,
  type KeyInput,
  type Keychain,
} from "./auth.js";
import { run } from "./run.js";

/*
 * `epoch auth` (ADR-009). A key arrives on standard input only, is never
 * written back, and the environment wins over the OS keychain. The real
 * keychain is replaced by a map; the real library is exercised only by the
 * opt-in test at the end.
 */

const KEY = "sk-test-0123456789abcdef";

// A throwaway cache, never the user's.
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-cli-auth-"));
process.env.EPOCH_CACHE_DIR = cacheDir;
afterAll(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

/** Files sharing a key-like string: a candidate pair a model would score (as in scorer.test.ts). */
function project(): string {
  const dir = fs.mkdtempSync(path.join(cacheDir, "p-"));
  const files: Record<string, string> = {
    "src/pub.ts": 'export const EVENT = "user.created";\n',
    "src/sub.ts": 'export const ON = "user.created";\n',
    "src/other.ts": "export const other = 1;\n",
    "src/more.ts": "export const more = 2;\n",
  };
  fs.mkdirSync(path.join(dir, "src"));
  for (const [rel, text] of Object.entries(files))
    fs.writeFileSync(path.join(dir, rel), text);
  return dir;
}

class FakeKeychain implements Keychain {
  readonly entries = new Map<string, string>();
  unavailable: string | undefined;
  get(provider: string): Promise<string | undefined> {
    if (this.unavailable) throw new KeychainUnavailable(this.unavailable);
    return Promise.resolve(this.entries.get(provider));
  }
  set(provider: string, value: string): Promise<void> {
    if (this.unavailable) throw new KeychainUnavailable(this.unavailable);
    this.entries.set(provider, value);
    return Promise.resolve();
  }
  remove(provider: string): Promise<boolean> {
    if (this.unavailable) throw new KeychainUnavailable(this.unavailable);
    return Promise.resolve(this.entries.delete(provider));
  }
}

/** Piped standard input holding `text`. */
function piped(text: string): KeyInput {
  const stream = new PassThrough();
  stream.end(text);
  return stream;
}

/** A terminal: raw mode is recorded, keystrokes arrive as chunks. */
function terminal(chunks: string[]): KeyInput & { raw: boolean[] } {
  const stream = new PassThrough() as PassThrough & {
    isTTY: boolean;
    raw: boolean[];
    setRawMode(on: boolean): void;
  };
  stream.isTTY = true;
  stream.raw = [];
  stream.setRawMode = (on: boolean) => {
    stream.raw.push(on);
  };
  stream.setEncoding("utf8");
  setImmediate(() => {
    for (const c of chunks) stream.write(c);
  });
  return stream;
}

function capture() {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: {
        write: (s: string) => {
          out += s;
        },
      },
      stderr: {
        write: (s: string) => {
          err += s;
        },
      },
    },
    out: () => out,
    err: () => err,
  };
}

function deps(over: Partial<AuthDeps> = {}): AuthDeps & {
  keychain: FakeKeychain;
} {
  return {
    keychain: new FakeKeychain(),
    input: piped(`${KEY}\n`),
    env: {},
    ...over,
  } as AuthDeps & { keychain: FakeKeychain };
}

describe("readKey", () => {
  it("takes piped input without its line ending", async () => {
    const c = capture();
    expect(await readKey(piped(`${KEY}\n`), "Key: ", c.io.stderr)).toBe(KEY);
    expect(await readKey(piped(`${KEY}\r\n`), "Key: ", c.io.stderr)).toBe(KEY);
    expect(await readKey(piped(KEY), "Key: ", c.io.stderr)).toBe(KEY);
    // No prompt when nobody is typing.
    expect(c.err()).toBe("");
  });

  it("reads a terminal in raw mode, hidden, with backspace", async () => {
    const c = capture();
    const tty = terminal(["sk-x", "x\u007f", "y", "\r"]);
    expect(await readKey(tty, "Key: ", c.io.stderr)).toBe("sk-xy");
    expect(tty.raw).toEqual([true, false]);
    // The prompt and a line break; never the characters typed.
    expect(c.err()).toBe("Key: \n");
  });

  it("takes a pasted key ending in a line break in one chunk", async () => {
    const c = capture();
    expect(await readKey(terminal([`${KEY}\r`]), "Key: ", c.io.stderr)).toBe(
      KEY,
    );
  });

  it("stops on Ctrl-C and leaves raw mode", async () => {
    const c = capture();
    const tty = terminal(["sk-", "\u0003"]);
    await expect(readKey(tty, "Key: ", c.io.stderr)).rejects.toThrow(
      "cancelled",
    );
    expect(tty.raw).toEqual([true, false]);
  });
});

describe("epoch auth", () => {
  it("set stores the key from standard input and never prints it", async () => {
    const c = capture();
    const d = deps();
    expect(await authCommand(["set", "anthropic"], c.io, d)).toBe(0);
    expect(d.keychain.entries.get("anthropic")).toBe(KEY);
    expect(c.out()).toContain("Saved the Anthropic key in the OS keychain");
    expect(c.out() + c.err()).not.toContain(KEY);
  });

  it("set refuses a key on the command line without echoing it", async () => {
    const c = capture();
    const d = deps();
    const code = await run(["auth", "set", "anthropic", KEY], c.io, d);
    expect(code).toBe(1);
    expect(c.err()).toContain("standard input");
    expect(c.out() + c.err()).not.toContain(KEY);
    expect(d.keychain.entries.size).toBe(0);
  });

  it("never echoes an unknown provider, which may be a key typed in its place", async () => {
    const c = capture();
    const code = await run(["auth", "set", KEY], c.io, deps());
    expect(code).toBe(1);
    expect(c.err()).toContain("unknown provider");
    expect(c.err()).toContain("anthropic");
    expect(c.out() + c.err()).not.toContain(KEY);
  });

  it("never echoes an option, which may carry a key", async () => {
    const c = capture();
    const code = await run(
      ["auth", "set", "anthropic", `--key=${KEY}`],
      c.io,
      deps(),
    );
    expect(code).toBe(1);
    expect(c.out() + c.err()).not.toContain(KEY);
  });

  it("set rejects an empty key or one with spaces, without echoing it", async () => {
    for (const [bad, why] of [
      ["", "no key was given"],
      ["sk two words", "contains spaces"],
      ["k".repeat(513), "longer than 512"],
    ] as const) {
      const c = capture();
      const d = deps({ input: piped(`${bad}\n`) });
      expect(await run(["auth", "set", "anthropic"], c.io, d)).toBe(1);
      expect(d.keychain.entries.size).toBe(0);
      expect(c.err()).toContain(why);
      if (bad !== "") expect(c.err()).not.toContain(bad);
    }
  });

  it("set notes that the environment still wins", async () => {
    const c = capture();
    const d = deps({ env: { ANTHROPIC_API_KEY: "from-env" } });
    expect(await authCommand(["set", "anthropic"], c.io, d)).toBe(0);
    expect(c.out()).toContain("ANTHROPIC_API_KEY is set");
    expect(c.out()).not.toContain("from-env");
  });

  it("status says where a key is, never what it is", async () => {
    const d = deps();
    let c = capture();
    await authCommand(["status"], c.io, d);
    expect(c.out()).toMatch(/anthropic\s+not set/);

    d.keychain.entries.set("anthropic", KEY);
    c = capture();
    await authCommand(["status", "anthropic"], c.io, d);
    expect(c.out()).toMatch(/anthropic\s+OS keychain/);

    c = capture();
    await authCommand(["status"], c.io, {
      ...d,
      env: { ANTHROPIC_API_KEY: "from-env" },
    });
    expect(c.out()).toMatch(
      /anthropic\s+environment \(ANTHROPIC_API_KEY\), used first; also in the OS keychain/,
    );
    expect(c.out()).not.toContain(KEY);
    expect(c.out()).not.toContain("from-env");
  });

  it("status reports a keychain that cannot be used", async () => {
    const d = deps();
    d.keychain.unavailable = "no Secret Service is running";
    const c = capture();
    expect(await authCommand(["status"], c.io, d)).toBe(0);
    expect(c.out()).toContain("OS keychain not available");
    expect(c.out()).toContain("no Secret Service is running");
  });

  it("remove deletes the stored key", async () => {
    const d = deps();
    d.keychain.entries.set("anthropic", KEY);
    let c = capture();
    expect(await authCommand(["remove", "anthropic"], c.io, d)).toBe(0);
    expect(d.keychain.entries.size).toBe(0);
    expect(c.out()).toContain("Removed the Anthropic key");
    c = capture();
    await authCommand(["remove", "anthropic"], c.io, d);
    expect(c.out()).toContain("No Anthropic key in the OS keychain");
  });

  it("set and remove fail with advice when the keychain cannot be used", async () => {
    const d = deps();
    d.keychain.unavailable = "no Secret Service is running";
    const c = capture();
    expect(await run(["auth", "set", "anthropic"], c.io, d)).toBe(1);
    expect(c.err()).toContain("no Secret Service is running");
    expect(c.err()).toContain("ANTHROPIC_API_KEY");
    expect(c.err()).not.toContain(KEY);
  });

  it("needs a known subcommand", async () => {
    const c = capture();
    expect(await run(["auth"], c.io, deps())).toBe(1);
    expect(c.err()).toContain("auth needs set, status or remove");
  });
});

describe("resolveKey", () => {
  it("prefers the environment, then the keychain", async () => {
    const keychain = new FakeKeychain();
    keychain.entries.set("anthropic", KEY);
    expect(
      await resolveKey("anthropic", { ANTHROPIC_API_KEY: "e" }, keychain),
    ).toEqual({ value: "e", source: "environment" });
    expect(await resolveKey("anthropic", {}, keychain)).toEqual({
      value: KEY,
      source: "keychain",
    });
    expect(
      await resolveKey("anthropic", { ANTHROPIC_API_KEY: "" }, keychain),
    ).toEqual({ value: KEY, source: "keychain" });
    keychain.entries.clear();
    expect(await resolveKey("anthropic", {}, keychain)).toEqual({});
    keychain.unavailable = "locked";
    expect(await resolveKey("anthropic", {}, keychain)).toEqual({
      unavailable: "locked",
    });
  });

  it("feeds --scorer llm a keychain key when the environment has none", async () => {
    const keychain = new FakeKeychain();
    keychain.entries.set("anthropic", KEY);
    const c = capture();
    const code = await run(
      [
        "analyze",
        project(),
        "--scorer",
        "llm",
        "--max-spend",
        "0.01",
        "--price-in",
        "1",
        "--price-out",
        "5",
      ],
      c.io,
      { keychain, env: {} },
    );
    // Without --consent-send the scorer prints its plan and stops: it had a key.
    expect(code).toBe(1);
    expect(c.err()).toContain("Nothing has been sent");
    expect(c.err()).not.toContain("needs your own Anthropic key");
    expect(c.out() + c.err()).not.toContain(KEY);
  });

  it("asks for a key in either place when there is none", async () => {
    const c = capture();
    const code = await run(["analyze", project(), "--scorer", "llm"], c.io, {
      keychain: new FakeKeychain(),
      env: {},
    });
    expect(code).toBe(1);
    expect(c.err()).toContain("epoch auth set anthropic");
    expect(c.err()).toContain("ANTHROPIC_API_KEY");
  });

  it("says why the keychain was not used", async () => {
    const keychain = new FakeKeychain();
    keychain.unavailable = "no Secret Service is running";
    const c = capture();
    const code = await run(["analyze", project(), "--scorer", "llm"], c.io, {
      keychain,
      env: {},
    });
    expect(code).toBe(1);
    expect(c.err()).toContain(
      "the OS keychain is not available (no Secret Service is running)",
    );
  });

  it("does not open the keychain unless a model needs a key", async () => {
    const keychain = new FakeKeychain();
    keychain.unavailable = "should not be asked";
    const c = capture();
    expect(await run(["analyze", project()], c.io, { keychain, env: {} })).toBe(
      0,
    );
    expect(
      await run(["analyze", project(), "--scorer", "llm"], c.io, {
        keychain,
        env: { ANTHROPIC_API_KEY: "from-env" },
      }),
    ).toBe(1);
    expect(c.err()).not.toContain("should not be asked");
  });
});

// The real OS keychain, where CI turns it on (macOS and Windows; Linux CI
// has no Secret Service). A throwaway service name, removed afterwards.
describe.runIf(process.env.EPOCH_TEST_REAL_KEYCHAIN === "1")(
  "osKeychain (real)",
  () => {
    it("stores, reads and removes a key", async () => {
      const { osKeychain } = await import("./auth.js");
      const keychain = osKeychain(`epoch-test-${String(process.pid)}`);
      try {
        await keychain.set("anthropic", KEY);
        expect(await keychain.get("anthropic")).toBe(KEY);
      } finally {
        expect(await keychain.remove("anthropic")).toBe(true);
      }
      expect(await keychain.get("anthropic")).toBeUndefined();
      expect(await keychain.remove("anthropic")).toBe(false);
    });
  },
);
