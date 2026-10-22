# ADR-014: FileFacts carries key-like string literals

- **Status:** Accepted (the maintainer approved the CLAUDE.md contract change in the M6 plan, 2026-10-16)
- **Date:** 2026-10-16
- **Milestone:** M6

## Context

M6 adds shared-string hints (PLAN.md): files that use the same event name, route, topic or config key are often related even when neither imports the other, for example a publisher and a subscriber of `"user.created"`. To link them, Epoch needs each file's literals. CLAUDE.md's `FileFacts` contract carried only import specifiers, export names and flag keys, and the cache rule ("no source stored") listed only those as literals the cache may keep.

The literals have to come from the extract stage: it is the only stage that sees syntax trees, and its output is the cached unit, so a re-run reads them from the cache instead of parsing again.

## Decision

1. **`FileFacts.strings: string[]`**, a new field in CLAUDE.md's data contract: the file's key-like literals, at most 64, sorted.
2. **What counts as key-like** (`isKeyLikeLiteral` in `packages/core/src/strings.ts`, pure, shared by every adapter):
   - 3 to 100 characters, only letters, digits and `_ . : / @ # { } -` (no whitespace, quotes or format syntax), with at least one letter;
   - a separator (`. _ : / -`) or camelCase, so plain words do not count;
   - not a relative path (`./`, `../`), a URL with a scheme, a file extension (`.ts`) or a MIME type (`text/plain`).
3. **Which literals:** every string literal with a plain value (no substitution: template literals with `${}`, f-strings and bytes are skipped), in source order, minus the file's own import specifiers; the first 64 distinct ones are kept, then sorted. Each adapter finds its literals with a `queries/<language>/strings.scm` tree-sitter query.
4. **Cache rule:** key-like strings join specifiers, export names and flag keys as the short literals the cache may keep. They are identifiers rather than code; the no-source test still applies.
5. **Adapter versions** bump (TypeScript 7, Python 4, Go 4), so every cached `FileFacts` row is re-extracted; the extract fingerprints are re-recorded.

## Alternatives considered

- **An optional adapter method for strings.** It would also change a CLAUDE.md contract (`LanguageAdapter`), cost a second parse or a second cache, and split one file's facts across two places.
- **Per-language string queries in the engine.** Adding a language would then mean touching the engine, against CLAUDE.md's "adding a language must mean writing one adapter".
- **Hashing the strings.** It would keep literal text out of the cache, but the hint's evidence must name the shared string ("both use `user.created`"), and the strings are no more sensitive than the flag keys already stored.

## Consequences

- Shared-string hints read the strings from cached facts; how they are weighted (rarity) and scored belongs to ADR-008.
- Extraction does one more query per file; its cost is part of the parse timings measured in the benchmarks.
- Everything stays local: the strings never leave the machine, and no remote model sees them unless the user opts in to one (CLAUDE.md data-flow table).
