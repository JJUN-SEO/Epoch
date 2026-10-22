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

/**
 * A private key in PEM form: the encapsulation boundary
 * "-----BEGIN <label>-----" (RFC 7468, section 2) with a label ending in
 * PRIVATE KEY, which covers PKCS #8 ("PRIVATE KEY", section 10),
 * "ENCRYPTED PRIVATE KEY" (section 11) and the legacy "RSA", "EC" and
 * "OPENSSH" forms. https://www.rfc-editor.org/rfc/rfc7468
 */
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

/** Whether a file's content holds a secret, whatever its name: never sent to a model. */
export const looksLikeSecretContent = (text: string): boolean =>
  PEM_PRIVATE_KEY.test(text);
