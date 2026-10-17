import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { KeyStatus } from "@epoch-dev/core";

/*
 * The user's model keys in the app (CLAUDE.md "Bring your own keys";
 * ADR-016): encrypted with Electron safeStorage (its async API), kept as
 * ciphertext in Epoch's data directory (an owner-only file), and decrypted
 * in main only, for the one request that needs it. Linux without a keyring
 * (safeStorage's "basic_text" backend) gives weak protection: main asks the
 * user, and keeps the key for this session unless told to store it anyway.
 */

/** The parts of Electron's safeStorage used here; a fake in tests. */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(
    encrypted: Buffer,
  ): Promise<{ result: string; shouldReEncrypt: boolean }>;
  getSelectedStorageBackend(): string;
}

/** How well a stored key would be protected here. */
export type KeyProtection = "encrypted" | "weak" | "none";

const KeyFile = z.object({
  version: z.literal(1),
  keys: z.record(
    z.string(),
    z.object({
      /** base64 safeStorage ciphertext. */
      ciphertext: z.string(),
      weak: z.boolean(),
    }),
  ),
});
type KeyFile = z.infer<typeof KeyFile>;

export class KeyStore {
  private readonly file: string;
  private readonly safe: SafeStorageLike;
  private readonly platform: NodeJS.Platform;
  /** Keys kept for this session only, never written. */
  private readonly session = new Map<string, string>();

  constructor(file: string, safe: SafeStorageLike, platform: NodeJS.Platform) {
    this.file = file;
    this.safe = safe;
    this.platform = platform;
  }

  /** encrypted: OS-protected; weak: Linux without a keyring; none: cannot encrypt. */
  async protection(): Promise<KeyProtection> {
    if (!(await this.safe.isAsyncEncryptionAvailable())) return "none";
    return this.platform === "linux" &&
      this.safe.getSelectedStorageBackend() === "basic_text"
      ? "weak"
      : "encrypted";
  }

  /**
   * Keeps a key: "store" writes its ciphertext (weakly protected when that is
   * all this machine offers, which main confirms first); "session" keeps it
   * in memory until Epoch quits. Without encryption it is session-only.
   */
  async set(
    provider: string,
    value: string,
    mode: "store" | "session",
  ): Promise<KeyStatus> {
    const protection = await this.protection();
    const keys = this.read();
    if (mode === "session" || protection === "none") {
      Reflect.deleteProperty(keys.keys, provider);
      this.write(keys);
      this.session.set(provider, value);
      return { configured: true, storage: "session" };
    }
    const ciphertext = (await this.safe.encryptStringAsync(value)).toString(
      "base64",
    );
    keys.keys[provider] = { ciphertext, weak: protection === "weak" };
    this.write(keys);
    this.session.delete(provider);
    return { configured: true, storage: protection };
  }

  /** The key, for main's own request. Undefined when unset or undecryptable. */
  async get(provider: string): Promise<string | undefined> {
    const kept = this.session.get(provider);
    if (kept !== undefined) return kept;
    const entry = this.read().keys[provider];
    if (!entry) return undefined;
    try {
      const { result, shouldReEncrypt } = await this.safe.decryptStringAsync(
        Buffer.from(entry.ciphertext, "base64"),
      );
      if (shouldReEncrypt) {
        const keys = this.read();
        keys.keys[provider] = {
          ...entry,
          ciphertext: (await this.safe.encryptStringAsync(result)).toString(
            "base64",
          ),
        };
        this.write(keys);
      }
      return result;
    } catch {
      return undefined; // a changed keychain or a damaged entry: not usable
    }
  }

  async status(provider: string): Promise<KeyStatus> {
    if (this.session.has(provider))
      return { configured: true, storage: "session" };
    const entry = this.read().keys[provider];
    if (!entry || (await this.get(provider)) === undefined)
      return { configured: false };
    return { configured: true, storage: entry.weak ? "weak" : "encrypted" };
  }

  remove(provider: string): Promise<void> {
    this.session.delete(provider);
    const keys = this.read();
    if (Reflect.deleteProperty(keys.keys, provider)) this.write(keys);
    return Promise.resolve();
  }

  private read(): KeyFile {
    try {
      const parsed = KeyFile.safeParse(
        JSON.parse(fs.readFileSync(this.file, "utf8")),
      );
      if (parsed.success) return parsed.data;
    } catch {
      // missing or unreadable
    }
    return { version: 1, keys: {} };
  }

  private write(keys: KeyFile): void {
    if (Object.keys(keys.keys).length === 0 && !fs.existsSync(this.file))
      return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(keys)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
