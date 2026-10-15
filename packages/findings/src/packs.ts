import { FlagPattern } from "@epoch-dev/core";
import openfeature from "./packs/openfeature.json" with { type: "json" };

/*
 * Flag pattern packs (CLAUDE.md "Flag detection"): data, validated here.
 * Every entry cites the official source it was written from (`source`):
 * the OpenFeature SDKs' own client and hook definitions, pinned to a commit
 * of open-feature/js-sdk, python-sdk and go-sdk on GitHub. Vendor SDKs come
 * later (your M5 answer: OpenFeature only for now).
 *
 * `language` is the adapter id: "typescript" covers TypeScript and JavaScript.
 * Calls are matched by callee name and the key's argument position; the
 * React SDK's <FeatureFlag flagKey=...> component is JSX, not a call, and is
 * not matched.
 */

/** The OpenFeature evaluation API in TS/JS (clients and React hooks), Python and Go. */
export const OPENFEATURE_PATTERNS: readonly FlagPattern[] = openfeature.map(
  (p) => FlagPattern.parse(p),
);

/** The patterns every analysis uses. */
export const DEFAULT_FLAG_PATTERNS: readonly FlagPattern[] =
  OPENFEATURE_PATTERNS;
