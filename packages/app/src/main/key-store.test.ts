import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeyStore, type SafeStorageLike } from "./key-store";

const KEY = "sk-test-SENTINEL-0123456789";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function file(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-keys-"));
  dirs.push(dir);
  return path.join(dir, "keys.json");
}

/** A stand-in for safeStorage: reversible, and never the plaintext. */
function fakeSafe(
  opts: {
    available?: boolean;
    backend?: string;
    failDecrypt?: boolean;
    reEncrypt?: boolean;
  } = {},
): SafeStorageLike & { encrypted: number } {
  const fake = {
    encrypted: 0,
    isAsyncEncryptionAvailable: () => Promise.resolve(opts.available ?? true),
    encryptStringAsync: (plain: string) => {
      fake.encrypted++;
      return Promise.resolve(
        Buffer.from([...Buffer.from(plain)].map((b) => b ^ 0x5a)),
      );
    },
    decryptStringAsync: (enc: Buffer) =>
      opts.failDecrypt
        ? Promise.reject(new Error("Error while decrypting the ciphertext"))
        : Promise.resolve({
            result: Buffer.from([...enc].map((b) => b ^ 0x5a)).toString(),
            shouldReEncrypt: opts.reEncrypt ?? false,
          }),
    getSelectedStorageBackend: () => opts.backend ?? "gnome_libsecret",
  };
  return fake;
}

describe("KeyStore", () => {
  it("keeps only ciphertext, owner-only, across restarts", async () => {
    const f = file();
    const store = new KeyStore(f, fakeSafe(), "darwin");
    expect(await store.protection()).toBe("encrypted");
    expect(await store.set("anthropic", KEY, "store")).toEqual({
      configured: true,
      storage: "encrypted",
    });
    expect(fs.readFileSync(f, "utf8")).not.toContain(KEY);
    expect(fs.readFileSync(f).includes(Buffer.from(KEY))).toBe(false);
    if (process.platform !== "win32")
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    const again = new KeyStore(f, fakeSafe(), "darwin");
    expect(await again.get("anthropic")).toBe(KEY);
    expect(await again.status("anthropic")).toEqual({
      configured: true,
      storage: "encrypted",
    });
  });

  it("on Linux without a keyring keeps a key for this session unless told to store it weakly", async () => {
    const f = file();
    const weak = fakeSafe({ backend: "basic_text" });
    const store = new KeyStore(f, weak, "linux");
    expect(await store.protection()).toBe("weak");
    expect(await store.set("anthropic", KEY, "session")).toEqual({
      configured: true,
      storage: "session",
    });
    expect(fs.existsSync(f)).toBe(false);
    expect(await store.get("anthropic")).toBe(KEY);
    expect(await new KeyStore(f, weak, "linux").status("anthropic")).toEqual({
      configured: false,
    });
    expect(await store.set("anthropic", KEY, "store")).toEqual({
      configured: true,
      storage: "weak",
    });
    expect(await new KeyStore(f, weak, "linux").status("anthropic")).toEqual({
      configured: true,
      storage: "weak",
    });
  });

  it("keeps a key for this session only when encryption is unavailable", async () => {
    const f = file();
    const store = new KeyStore(f, fakeSafe({ available: false }), "win32");
    expect(await store.protection()).toBe("none");
    expect(await store.set("anthropic", KEY, "store")).toEqual({
      configured: true,
      storage: "session",
    });
    expect(fs.existsSync(f)).toBe(false);
  });

  it("treats a key it cannot decrypt as not configured", async () => {
    const f = file();
    await new KeyStore(f, fakeSafe(), "darwin").set("anthropic", KEY, "store");
    const broken = new KeyStore(f, fakeSafe({ failDecrypt: true }), "darwin");
    expect(await broken.get("anthropic")).toBeUndefined();
    expect(await broken.status("anthropic")).toEqual({ configured: false });
  });

  it("re-encrypts a key when the OS rotated its key", async () => {
    const f = file();
    await new KeyStore(f, fakeSafe(), "darwin").set("anthropic", KEY, "store");
    const rotated = fakeSafe({ reEncrypt: true });
    expect(await new KeyStore(f, rotated, "darwin").get("anthropic")).toBe(KEY);
    expect(rotated.encrypted).toBe(1);
  });

  it("removes a key everywhere", async () => {
    const f = file();
    const store = new KeyStore(f, fakeSafe(), "darwin");
    await store.set("anthropic", KEY, "store");
    await store.remove("anthropic");
    expect(await store.status("anthropic")).toEqual({ configured: false });
    expect(await new KeyStore(f, fakeSafe(), "darwin").get("anthropic")).toBe(
      undefined,
    );
  });

  it("ignores a damaged file", async () => {
    const f = file();
    fs.writeFileSync(f, "{not json");
    expect(
      await new KeyStore(f, fakeSafe(), "darwin").status("anthropic"),
    ).toEqual({ configured: false });
  });
});
