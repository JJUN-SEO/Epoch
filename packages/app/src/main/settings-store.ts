import fs from "node:fs";
import path from "node:path";
import {
  applySettingsPatch,
  parseSettings,
  spendRaises,
  type Settings,
} from "@epoch-dev/core";

/** The user declined a change that would let Epoch spend more. */
export class SettingsNotConfirmed extends Error {
  constructor() {
    super("The change was not confirmed.");
    this.name = "SettingsNotConfirmed";
  }
}

/** Asks the user, in a native dialog main owns, to allow these spending changes. */
export type ConfirmRaises = (raises: readonly string[]) => Promise<boolean>;

/**
 * The app's settings (ADR-016), in Epoch's own data directory (owner-only
 * file). Changes arrive as validated patches (core SettingsPatch); one that
 * lets Epoch spend more is saved only after the user confirms it natively,
 * so the renderer alone can never raise a limit or lower a price.
 */
export class SettingsStore {
  readonly warnings: readonly string[];
  private readonly file: string;
  private current: Settings;
  private readonly listeners = new Set<(s: Settings) => void>();

  constructor(file: string) {
    this.file = file;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      raw = undefined; // missing or unreadable: the defaults
    }
    const { settings, warnings } = parseSettings(raw);
    this.current = settings;
    this.warnings = warnings;
  }

  get(): Settings {
    return this.current;
  }

  async update(patch: unknown, confirm: ConfirmRaises): Promise<Settings> {
    const next = applySettingsPatch(this.current, patch);
    const raises = spendRaises(this.current, next);
    if (raises.length > 0 && !(await confirm(raises)))
      throw new SettingsNotConfirmed();
    this.save(next);
    this.current = next;
    for (const listener of this.listeners) listener(next);
    return next;
  }

  onChange(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private save(settings: Settings): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(tmp, this.file);
  }
}
