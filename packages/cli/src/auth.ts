import type { Readable } from "node:stream";

/*
 * `epoch auth set|status|remove <provider>` (ADR-009): the user's own model
 * keys for the CLI. A key is read from standard input (hidden at a
 * terminal), never from the command line, and never written back out. It
 * is stored in the OS keychain through @napi-rs/keyring, an optional
 * dependency loaded only when a key is needed. An environment variable
 * always wins over the keychain, so CI and scripts keep working unchanged.
 */

export const PROVIDERS = {
  anthropic: { label: "Anthropic", env: "ANTHROPIC_API_KEY" },
} as const;

export type Provider = keyof typeof PROVIDERS;

const isProvider = (name: string): name is Provider =>
  Object.hasOwn(PROVIDERS, name);

/** Where keys are stored; the OS keychain, or a map in tests. */
export interface Keychain {
  get(provider: Provider): Promise<string | undefined>;
  set(provider: Provider, value: string): Promise<void>;
  /** True when a key was there to remove. */
  remove(provider: Provider): Promise<boolean>;
}

/** The keychain cannot be used here; the message says why, never a key. */
export class KeychainUnavailable extends Error {}

/** Standard input: piped text, or a terminal that can switch to raw mode. */
export type KeyInput = Readable & {
  readonly isTTY?: boolean;
  setRawMode?(on: boolean): unknown;
};

export interface AuthDeps {
  readonly keychain: Keychain;
  readonly input: KeyInput;
  readonly env: NodeJS.ProcessEnv;
}

export class AuthUsageError extends Error {}

/** Longer than any provider's key; a guard against pasting the wrong thing. */
const MAX_KEY_LENGTH = 512;
const MAX_INPUT_BYTES = 64 * 1024;

const firstLine = (message: string): string => message.split("\n")[0] ?? "";

/**
 * The OS keychain: macOS Keychain, Windows Credential Manager, or the
 * Secret Service on Linux (gnome-keyring, KWallet, KeePassXC). On Linux
 * the entry is pinned to the Secret Service: the library would otherwise
 * fall back to the kernel keyring, which forgets everything at reboot.
 */
export function osKeychain(service = "epoch"): Keychain {
  let lib: Promise<typeof import("@napi-rs/keyring")> | undefined;
  const entry = async (provider: Provider) => {
    lib ??= import("@napi-rs/keyring");
    let mod: typeof import("@napi-rs/keyring");
    try {
      mod = await lib;
    } catch {
      throw new KeychainUnavailable(
        "the keychain library (@napi-rs/keyring) is not installed",
      );
    }
    try {
      return new mod.AsyncEntry(service, provider, {
        linux: { store: "secret-service" },
      });
    } catch (err) {
      throw new KeychainUnavailable(
        process.platform === "linux"
          ? "no Secret Service (gnome-keyring, KWallet, KeePassXC) is running"
          : firstLine(err instanceof Error ? err.message : String(err)),
      );
    }
  };
  // A store error says what failed, not what was stored; the key is
  // redacted anyway, should a backend ever include it.
  const unavailable = (err: unknown, key?: string) => {
    if (err instanceof KeychainUnavailable) return err;
    let message = firstLine(err instanceof Error ? err.message : String(err));
    if (key) message = message.split(key).join("[key]");
    return new KeychainUnavailable(message);
  };
  return {
    async get(provider) {
      try {
        // The binding resolves null, not undefined, when nothing is stored.
        return (await (await entry(provider)).getPassword()) ?? undefined;
      } catch (err) {
        throw unavailable(err);
      }
    },
    async set(provider, value) {
      try {
        await (await entry(provider)).setPassword(value);
      } catch (err) {
        throw unavailable(err, value);
      }
    },
    async remove(provider) {
      try {
        return await (await entry(provider)).deletePassword();
      } catch (err) {
        throw unavailable(err);
      }
    },
  };
}

/**
 * A key typed at a terminal (raw mode: nothing is echoed, backspace works,
 * Ctrl-C cancels) or piped in (its line ending removed). The prompt goes to
 * stderr, and only at a terminal.
 */
export function readKey(
  input: KeyInput,
  prompt: string,
  stderr: { write(chunk: string): unknown },
): Promise<string> {
  if (input.isTTY === true && input.setRawMode) {
    const setRawMode = input.setRawMode.bind(input);
    return new Promise((resolve, reject) => {
      let typed = "";
      const finish = (err?: Error) => {
        input.off("data", onData);
        setRawMode(false);
        input.pause();
        stderr.write("\n");
        if (err) reject(err);
        else resolve(typed);
      };
      const onData = (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        // An arrow or function key: an escape sequence, not part of a key.
        if (text.startsWith("\u001b")) return;
        for (const ch of text) {
          if (ch === "\r" || ch === "\n" || (ch === "\u0004" && typed !== "")) {
            finish();
            return;
          }
          if (ch === "\u0003" || ch === "\u0004") {
            finish(new AuthUsageError("cancelled; nothing was stored"));
            return;
          }
          if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
          else if (ch >= " ") typed += ch;
        }
      };
      stderr.write(prompt);
      setRawMode(true);
      input.setEncoding("utf8");
      input.on("data", onData);
      input.resume();
    });
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    input.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buf.length;
      if (bytes > MAX_INPUT_BYTES) {
        input.destroy();
        reject(new AuthUsageError("standard input is too long for a key"));
        return;
      }
      chunks.push(buf);
    });
    input.once("error", reject);
    input.once("end", () => {
      resolve(
        Buffer.concat(chunks)
          .toString("utf8")
          .replace(/\r?\n$/, ""),
      );
    });
  });
}

/** Why a key cannot be stored, in words that never include the key. */
function badKey(value: string): string | undefined {
  if (value === "") return "no key was given";
  if (value.length > MAX_KEY_LENGTH)
    return `the key is longer than ${String(MAX_KEY_LENGTH)} characters`;
  // eslint-disable-next-line no-control-regex -- control characters are what this rejects
  if (/[\s\u0000-\u001f\u007f]/.test(value))
    return "the key contains spaces, line breaks or control characters";
  return undefined;
}

export type ResolvedKey =
  | { readonly value: string; readonly source: "environment" | "keychain" }
  | { readonly value?: undefined; readonly unavailable?: string };

/** The provider's key: its environment variable first, then the keychain. */
export async function resolveKey(
  provider: Provider,
  env: NodeJS.ProcessEnv,
  keychain: Keychain,
): Promise<ResolvedKey> {
  const fromEnv = env[PROVIDERS[provider].env];
  if (fromEnv !== undefined && fromEnv !== "")
    return { value: fromEnv, source: "environment" };
  try {
    const stored = await keychain.get(provider);
    return stored === undefined ? {} : { value: stored, source: "keychain" };
  } catch (err) {
    if (err instanceof KeychainUnavailable) return { unavailable: err.message };
    throw err;
  }
}

/**
 * A provider named on the command line. Never echoed when unknown: a key
 * typed in its place would end up in the error message.
 */
function providerOf(arg: string | undefined): Provider {
  if (arg !== undefined && isProvider(arg)) return arg;
  throw new AuthUsageError(
    `${arg === undefined ? "missing provider" : "unknown provider"}; known: ${Object.keys(PROVIDERS).join(", ")}`,
  );
}

function keychainError(err: unknown, provider: Provider): unknown {
  if (!(err instanceof KeychainUnavailable)) return err;
  return new Error(
    `the OS keychain is not available (${err.message}); set ${PROVIDERS[provider].env} in your environment instead`,
  );
}

const envNote = (provider: Provider, env: NodeJS.ProcessEnv): string => {
  const name = PROVIDERS[provider].env;
  return env[name] !== undefined && env[name] !== ""
    ? `Note: ${name} is set in this environment, and Epoch uses it first.\n`
    : "";
};

export async function authCommand(
  args: readonly string[],
  io: {
    stdout: { write(chunk: string): unknown };
    stderr: { write(chunk: string): unknown };
  },
  deps: AuthDeps,
): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "set" && sub !== "status" && sub !== "remove")
    throw new AuthUsageError(
      sub === undefined
        ? "auth needs set, status or remove"
        : "unknown auth command; use set, status or remove",
    );
  // Options are refused without being repeated: `--key=...` carries a key.
  if (rest.some((a) => a.startsWith("-")))
    throw new AuthUsageError(
      "auth takes no options; a key is read from standard input",
    );

  if (sub === "status") {
    if (rest.length > 1)
      throw new AuthUsageError("auth status takes one provider at most");
    const providers =
      rest.length === 1
        ? [providerOf(rest[0])]
        : (Object.keys(PROVIDERS) as Provider[]);
    for (const provider of providers) {
      const name = PROVIDERS[provider].env;
      const inEnv = deps.env[name] !== undefined && deps.env[name] !== "";
      let stored: string;
      try {
        stored =
          (await deps.keychain.get(provider)) === undefined
            ? ""
            : "OS keychain";
      } catch (err) {
        if (!(err instanceof KeychainUnavailable)) throw err;
        stored = `OS keychain not available: ${err.message}`;
      }
      const where = inEnv
        ? `environment (${name}), used first${stored === "OS keychain" ? "; also in the OS keychain" : stored === "" ? "" : `; ${stored}`}`
        : stored === ""
          ? `not set (epoch auth set ${provider}, or ${name})`
          : stored;
      io.stdout.write(`${provider.padEnd(10)} ${where}\n`);
    }
    return 0;
  }

  if (rest.length > 1) {
    throw new AuthUsageError(
      sub === "set"
        ? "auth set reads the key from standard input, never from the command line: run `epoch auth set <provider>` and paste it, or pipe it in"
        : "auth remove takes one provider",
    );
  }
  const provider = providerOf(rest[0]);
  const { label } = PROVIDERS[provider];

  if (sub === "remove") {
    let removed: boolean;
    try {
      removed = await deps.keychain.remove(provider);
    } catch (err) {
      throw keychainError(err, provider);
    }
    io.stdout.write(
      (removed
        ? `Removed the ${label} key from the OS keychain.\n`
        : `No ${label} key in the OS keychain.\n`) +
        envNote(provider, deps.env),
    );
    return 0;
  }

  // Fail before asking for a key that could not be stored.
  try {
    await deps.keychain.get(provider);
  } catch (err) {
    throw keychainError(err, provider);
  }
  const value = await readKey(
    deps.input,
    `${label} API key (input hidden): `,
    io.stderr,
  );
  const why = badKey(value);
  if (why !== undefined) throw new AuthUsageError(`${why}; nothing was stored`);
  try {
    await deps.keychain.set(provider, value);
  } catch (err) {
    throw keychainError(err, provider);
  }
  io.stdout.write(
    `Saved the ${label} key in the OS keychain (service "epoch", account "${provider}").\n` +
      envNote(provider, deps.env),
  );
  return 0;
}
