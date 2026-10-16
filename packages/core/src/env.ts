/*
 * The environment Epoch hands to processes it starts (git, the analysis
 * host). A key exported in the shell that launched Epoch must not travel
 * further than the code that needs it, so names that look like
 * credentials are left out: provider variables (ANTHROPIC_*), API keys,
 * tokens, secrets, passwords and credentials, in any case. A denylist,
 * not an allowlist: git on Windows needs variables no list could foresee.
 */

const SECRET_NAME = /^ANTHROPIC_|API_?KEY$|TOKEN$|SECRET|PASSWORD|CREDENTIAL/i;

/** `env` without unset values and without anything that looks like a credential. */
export function withoutSecrets(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !SECRET_NAME.test(name)) out[name] = value;
  }
  return out;
}
