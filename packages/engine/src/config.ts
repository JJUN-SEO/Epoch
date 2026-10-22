import {
  DEFAULT_EPOCH_CONFIG,
  EpochConfig,
  globMatcher,
  type ExtractorConfig,
} from "@epoch-dev/core";
import { DEFAULT_FLAG_PATTERNS } from "@epoch-dev/findings";
import type { FsReader } from "./reader.js";

/** The optional project config (CLAUDE.md "epoch.config.json"). */
export const CONFIG_FILE = "epoch.config.json";
/** A larger config is ignored, with a warning. */
export const MAX_CONFIG_BYTES = 64 * 1024;

export interface LoadedConfig {
  readonly config: EpochConfig;
  /** The project has an epoch.config.json (valid or not). */
  readonly present: boolean;
  /** Problems found; the analysis goes on with the defaults for each. */
  readonly warnings: readonly string[];
}

const KNOWN: Readonly<Record<string, ReadonlySet<string>>> = {
  "": new Set(["entryPoints", "ignore", "flags", "findings"]),
  flags: new Set([
    "wrapperFunctions",
    "envPrefixes",
    "longLived",
    "staleAfterDays",
  ]),
  findings: new Set(["minConfidence", "ignore"]),
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function unknownKeys(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!(KNOWN[""]?.has(key) ?? false)) out.push(key);
    else if (isRecord(value) && KNOWN[key]) {
      for (const sub of Object.keys(value)) {
        if (!KNOWN[key].has(sub)) out.push(`${key}.${sub}`);
      }
    }
  }
  return out.sort();
}

/**
 * Reads epoch.config.json at the project root as data (JSON only, never
 * executed, never written; CLAUDE.md principle 8). A missing file gives the
 * defaults; an unreadable, oversized or invalid one gives the defaults and a
 * warning, so a bad config never stops the analysis. Unknown keys warn.
 * Glob patterns that the matcher refuses (too long, too many alternatives)
 * are dropped with a warning.
 */
export function loadConfig(root: string, reader: FsReader): LoadedConfig {
  const path = `${root}/${CONFIG_FILE}`;
  if (!reader.fileExists(path)) {
    return { config: DEFAULT_EPOCH_CONFIG, present: false, warnings: [] };
  }
  const fail = (warning: string): LoadedConfig => ({
    config: DEFAULT_EPOCH_CONFIG,
    present: true,
    warnings: [`${CONFIG_FILE}: ${warning}; using the defaults`],
  });
  const bytes = reader.readBytes(path);
  if (bytes === undefined) return fail("unreadable");
  if (bytes.length > MAX_CONFIG_BYTES) {
    return fail(`larger than ${String(MAX_CONFIG_BYTES / 1024)} KiB`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fail("not valid JSON");
  }
  if (!isRecord(raw)) return fail("not a JSON object");
  const parsed = EpochConfig.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return fail(`invalid (${issues})`);
  }
  const warnings = unknownKeys(raw).map(
    (k) => `${CONFIG_FILE}: unknown key "${k}" (ignored)`,
  );
  const usable = (patterns: readonly string[], field: string) =>
    patterns.filter((p) => {
      try {
        globMatcher([p]);
        return true;
      } catch (err) {
        warnings.push(
          `${CONFIG_FILE}: ${field} pattern dropped: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    });
  const c = parsed.data;
  const config: EpochConfig = {
    ...c,
    entryPoints: usable(c.entryPoints, "entryPoints"),
    ignore: usable(c.ignore, "ignore"),
    findings: {
      ...c.findings,
      ignore: usable(c.findings.ignore, "findings.ignore"),
    },
  };
  return { config, present: true, warnings };
}

/** What Extract needs from the config: the pattern packs, wrappers and env prefixes. */
export function extractorConfigOf(config: EpochConfig): ExtractorConfig {
  return {
    flagPatterns: [...DEFAULT_FLAG_PATTERNS],
    wrapperFunctions: [...config.flags.wrapperFunctions],
    envPrefixes: [...config.flags.envPrefixes],
  };
}
