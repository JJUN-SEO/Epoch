# ADR-009: The CLI stores keys in the OS keychain through @napi-rs/keyring

- **Status:** Accepted (part of the M7 plan, approved 2026-10-16)
- **Date:** 2026-10-16

## Context

CLAUDE.md "Bring your own keys": the CLI takes the user's model keys from `epoch auth set <provider>` or environment variables, stores them in the OS keychain "via a maintained library (ADR)", and never in the cache, the repo, logs, error messages or exports. The maintainer chose the OS keychain plus environment variables, with the environment winning (M7 plan, decision 3).

Until now the CLI read `ANTHROPIC_API_KEY` only. M7 adds the `epoch auth` command and the keychain behind it. The app keeps its keys in Electron `safeStorage` (ADR-016); this ADR covers the CLI only.

## Options

1. **keytar.** The long-standing Node binding for macOS Keychain, Windows Credential Manager and libsecret. Its last release on npm, 7.9.0, was published on 2022-02-17. It needs node-gyp prebuilds that have not been refreshed since. Rejected: CLAUDE.md asks for a maintained library.
2. **@napi-rs/keyring.** A Node binding ([Brooooooklyn/keyring-node](https://github.com/Brooooooklyn/keyring-node), MIT) of the Rust [keyring](https://github.com/hwchen/keyring-rs) crate. It uses the same three OS stores and ships a prebuilt binary per platform as an optional dependency, with no install script, so `allowBuilds` needs no new entry. It has an async API (`AsyncEntry`: `setPassword`, `getPassword`, `deletePassword`). 2.1.1 was published on 2026-10-10, six days before this decision. 2.1.0 (2026-09-13) has had a month in use, so it is pinned exactly.
3. **Shell out to each OS's tool** (`security`, `secret-tool`, PowerShell). This means three code paths, and `security add-generic-password -w <password>` takes the secret as an argument, where other processes can see it. Rejected.
4. **Environment variables only.** This is the simplest option, and it stays the first source (below). The maintainer asked for a stored key as well.
5. **An encrypted file of Epoch's own.** Its encryption key would have to live somewhere, which brings back the keychain question. Rejected.

## Decision

1. **Library:** `@napi-rs/keyring` 2.1.0 is an exact-pinned optional dependency of `@epoch-dev/cli`. It is imported lazily, only by `epoch auth`, or by `--scorer llm` when the environment holds no key. Commands that need no key never load it. If the library is missing (its optional install failed), the CLI says so, and environment variables keep working.
2. **Entry:** service `epoch`, account = provider id (`anthropic`; more providers as they are built).
3. **Linux:** each entry is pinned to the Secret Service (gnome-keyring, KWallet, KeePassXC). By default the library falls back to the kernel keyutils keyring, which the library's README describes as in-memory only, lost at reboot. A key that disappears at reboot is not "stored", so without a Secret Service the CLI says so and points to the environment variable.
4. **Input:**
   - The key is read from standard input only: hidden at a terminal (raw mode, nothing echoed, backspace, Ctrl-C cancels), or piped (one trailing line ending removed).
   - A key given as an argument is refused, so it does not stay in shell history unnoticed.
   - Unknown providers and any options are refused without being repeated in the message, since either could be a key typed in the wrong place.
   - A key must be non-empty, at most 512 characters, with no spaces or control characters. The error says which rule failed, never the value.
   - `epoch auth set` checks that the keychain works before asking for the key.
5. **Output:**
   - No command prints a key.
   - `epoch auth status` says where a key would come from: the environment variable (used first), the OS keychain, both, or neither, and why the keychain cannot be used if it cannot.
   - Keychain errors are cut to their first line, with the key redacted in case a backend ever echoed it.
6. **Lookup:** the provider's environment variable when set and non-empty, else the keychain. The key reaches the scorer in a copy of the environment passed to `resolveModel`. It is never written into `process.env`, so child processes (git) never inherit it, and the git environment scrub stays a second line of defense.

## Testing

- **Unit tests** (`packages/cli/src/auth.test.ts`) run against a `Keychain` interface with an in-memory fake. They cover:
  - piped and terminal input (raw mode on and off, backspace, a pasted key, Ctrl-C);
  - a key on argv, an unknown provider and an option, none of them echoed;
  - validation, status, remove and an unavailable keychain;
  - the environment winning;
  - `--scorer llm` finding a keychain key;
  - the keychain not being opened when no model needs a key.
- **The real keychain** is tested on macOS and Windows in CI (`EPOCH_TEST_REAL_KEYCHAIN=1`): it stores, reads and removes a key under a throwaway service name. Linux runners have no Secret Service, and there the "not available" path is what users without one see.

## Consequences

- The CLI gains a native optional dependency: one prebuilt binary per platform, 3.1 MB on linux-x64. Platforms without a prebuilt binary fall back to environment variables.
- A headless Linux machine without a Secret Service uses the environment variable. The message says so.
- macOS may ask the user to allow access when a different Node binary (after a Node upgrade) reads an item another one stored. That is the keychain's own access control, not Epoch's.
- The app does not use this library. Its keys stay in `safeStorage` in main (ADR-016), so the two stores are separate: a key set with `epoch auth` is not visible to the app, and the other way round.
