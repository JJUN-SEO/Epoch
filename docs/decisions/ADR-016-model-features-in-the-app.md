# ADR-016: Model features in the desktop app

- **Status:** Accepted (the M7 plan, approved 2026-10-16). Changes the `EpochApi` contract in CLAUDE.md and adds one clause to its offline-mode rule.
- **Date:** 2026-10-17

## Context

M7 adds the app's first model feature: prose summaries of files, Go packages and folders (CLAUDE.md "Local cache": lazy, hierarchical, cached; "RelationScorer": prose summaries use a text LLM or a local model, never Jev). Before M7 the app had no keys, settings, spend control, offline mode or egress. The CLI already had hardened clients, spend caps and `--offline` (M6, M7 steps 1–6).

The maintainer decided four things for M7:

1. Summaries are made automatically when a file is opened, after a one-time consent per project, and reused while the file is unchanged.
2. Offline mode still allows a local model on this machine.
3. CLI keys live in the OS keychain plus environment variables (ADR-009).
4. Token cost is measured with the maintainer's own key, capped at $1.

This ADR records how the app does it safely.

## Decision

### Where requests come from

1. **Model calls run in main only.** CLAUDE.md allows main or the analysis host; main alone is a subset, so no rule changes.
   - The analysis host reads source through its root-confined reader, builds the prompt and owns the summary cache, but never sends anything.
   - Main checks settings, consent and budget, decrypts the key for that one call, sends, and records spend.
   - Keys never leave main.
2. **The host has no network at all.** It and its parse workers install the tripwire (`@epoch-dev/scorers/tripwire`): every socket, DNS lookup and fetch is refused, and each attempt is reported to main, which logs it.
3. **The host's environment is scrubbed.** Main forks it without variables that look like keys or tokens (core `withoutSecrets`), the same rule as for git.
4. **Bundles are checked.** A per-entry test fails if the host, a parse worker, the preload or the renderer carries a model client through any import, or if main's entry carries one outside a lazy chunk.

### Egress and offline mode

5. **One egress in main.** All of main's model requests go through `createNet` (origin allowlist, live offline flag, abort of requests in flight). The transport, a dedicated Electron session versus Node's fetch, is settled by the spike in M7 step 13; its result is recorded here.
6. **Offline mode** refuses every remote origin, reading the setting at each request (not a fixed flag), and aborts requests in flight when it is turned on. It allows only `http://127.0.0.1:11434`, and only when a local model is the user's summary provider. Update checks are forced off (the setting exists; the check itself is M8). CLAUDE.md's offline rule gains: "A local model on this machine that the user chose (loopback only) keeps working."

### Consent, approval and spend

7. **Consent** is per project (its resolved root) and provider, stored in Epoch's data directory, and given in a native dialog owned by main, so a compromised renderer cannot approve a send. The dialog states what is sent and where. A local model needs no consent, since nothing leaves the machine.
8. **Approval tokens.** When a request needs approval, main issues a single-use `planId` bound to the window and project. `generateSummary(planId)` rebuilds the plan; if the input changed or the worst-case cost rose, it asks again.
9. **Spend.**
   - A monthly cap is required before any paid call, with a reset button. There is a per-session budget, and a per-job threshold above which Epoch asks first.
   - Prices are entered by the user per `provider:model`. None ship with Epoch, and a model with no price makes paid summaries unavailable.
   - Each call reserves its worst case in a ledger (counts and USD only, no paths or content) before it is sent, and settles the actual usage after.
   - Raising what Epoch may spend asks in a native dialog (core `spendRaises`): a higher or first cap, a higher budget or threshold, or a lower or new price, since a zero price would make every cap meaningless.

### Summaries

10. **Cache** (the maintainer's "reuse while unchanged"):
    - Summaries are content-addressed: `key = sha256(prompt version, provider, model, subject, hash of the content sent)`. An unchanged file finds its summary again, including after switching branches and back.
    - Each summary records the dependency (or child) summaries it was given, by text hash. Fresh means the key hits and those still match (core `summaryStatus`, with a property test).
    - A per-project pointer keeps the latest summary per subject, shown as stale meanwhile. Stale because the file changed: regenerated on open if the auto rules pass. Stale because only a dependency's summary changed: an "Update" button, never automatic.
    - Pruning evicts summaries last, and Clear says how many paid summaries it deletes.
11. **Auto rules:** a summary is made on open only when all of these hold:
    - the Summary section is visible and the selection has held for about 0.75 s;
    - there is no fresh summary for this content;
    - consent was given;
    - the estimate is under the ask-first threshold and both budgets;
    - one call at a time, and a few per minute at most.

    A folder is always a confirmed job (core `folderJob`, bottom-up), with a total estimate, progress, cancel, and partial results kept.

12. **No source in the cache.** The host's store path drops code blocks and any sentence that repeats a line of the source sent (core `sourceLines`, the same rule as the cache's no-source test). Summaries are capped in length, shown as plain text and labeled "model-generated". Files that look like secrets, by name or by content (a PEM private key), are never sent, and are listed as not sent.

### Keys

13. **Keys** in the app live in Electron `safeStorage`, as ciphertext in `userData/keys.json` (mode 0600).
    - On Linux with the `basic_text` backend, Epoch warns (CLAUDE.md) and offers "this session only" (the default) or "store anyway (weak)".
    - The renderer sends a key once and learns only `{ configured, storage }`.
    - Errors carry fixed reason codes, never a key, a request option or provider text.

### Contract (CLAUDE.md `EpochApi`)

14. **New members:** `removeKey`, `getSummary(subject, { auto })`, `generateSummary(planId)`, `cancelSummaries`, `onSummaryProgress`, `getSpend`.
    - `getKeyStatus` also returns `storage`.
    - `updateSettings` takes a `SettingsPatch`: any field of any section, with `null` removing the cap or a price. It replaces `Partial<Settings>`, which forced whole sections.
    - `SummaryState` is `ready`, `needs-approval`, `unavailable` or `failed`, each with the cached text when there is one.

    The static demo serves precomputed summaries read-only and has no model features.

## Alternatives considered

- **Model calls in the analysis host,** next to the source. Rejected: keys and network would then live in the process that parses untrusted repositories. Main already holds keys (CLAUDE.md), and the host stays provably network-free.
- **Automatic regeneration on soft staleness.** Rejected: a change to one widely imported file would re-summarize every dependent and spend money the user never chose to spend.
- **Consent in the renderer.** Rejected: a compromised renderer could approve its own sends. Native dialogs come from main.
- **Shipping prices.** Rejected: CLAUDE.md forbids prices from memory, and prices change. The user enters them from the provider's page, and the M7 benchmark cites the page it used.

## Consequences

- A summary needs a key, a price, a monthly cap and consent before the first paid call. Each is a step in Settings, and the Summary section says which one is missing (`unavailable` reason codes).
- Main gains code that holds keys and sends requests. It is covered by unit tests with fakes for the host, the egress and `safeStorage`, and by e2e that stub the provider from the test side, so the app contains no test-only code.
- The host's network tripwire also guards against future dependencies that would phone home.
