import { globMatcher } from "@epoch-dev/core";

/*
 * Files that look like secrets are never sent to a model, even with consent
 * (CLAUDE.md "Privacy and data flow": `.env*`, keys, credentials). Matched on
 * the repo-relative path, ignoring case, with core's glob matcher.
 */

export const SECRET_PATTERNS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "**/*.env",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/*.kdbx",
  "**/id_rsa*",
  "**/id_dsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  "**/*credential*",
  "**/*secret*",
  "**/*password*",
  "**/*token*.json",
  "**/service-account*.json",
  "**/.npmrc",
  "**/.pypirc",
  "**/.netrc",
  "**/.git-credentials",
  "**/.aws/**",
  "**/.ssh/**",
  "**/.gnupg/**",
];

const matches = globMatcher(SECRET_PATTERNS.map((p) => p.toLowerCase()));

/** Whether a repo-relative path looks like it holds secrets. */
export const isSecretPath = (path: string): boolean =>
  matches(path.toLowerCase());
