import { releasePageUrl } from "./release";
import type { UpdateRecord } from "./update-store";
import { isNewer, parseVersion } from "./version";

/*
 * The update check (ADR-018): at most once a day, main asks the release host
 * for the latest release's tag, through its egress, and compares it here.
 * When it is newer, the window shows a notice that links to the release page;
 * the user downloads and installs it. Nothing is downloaded or run. Never
 * when update checks are off or offline mode is on.
 */

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A newer release, as the notice shows it. */
export interface AvailableUpdate {
  readonly current: string;
  readonly latest: string;
  /** The release page, built from a constant (never from the answer). */
  readonly url: string;
}

export interface UpdateCheckerDeps {
  readonly now: () => number;
  /** Update checks on and offline mode off, read at each use. */
  readonly allowed: () => boolean;
  /** This app's version (app.getVersion()). */
  readonly currentVersion: string;
  /** The latest release's tag name; rejects on any failure. */
  readonly latestTag: () => Promise<string>;
  /** Aborts a request in flight. */
  readonly abort: () => void;
  readonly store: {
    read(): UpdateRecord;
    write(record: UpdateRecord): void;
  };
  /** Tells the window about a newer release (once per release). */
  readonly notify: (update: AvailableUpdate) => void;
}

export class UpdateChecker {
  private readonly deps: UpdateCheckerDeps;
  private checking: Promise<void> | undefined;
  private notified: string | undefined;

  constructor(deps: UpdateCheckerDeps) {
    this.deps = deps;
  }

  /**
   * Asks the release host if the last answer is a day old (or the clock went
   * back), then tells the window about a newer release, if any.
   */
  tick(): Promise<void> {
    this.checking ??= this.check().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async check(): Promise<void> {
    const { deps } = this;
    if (!deps.allowed()) return;
    const record = deps.store.read();
    const now = deps.now();
    const age = now - record.lastCheckedAt;
    if (age >= 0 && age < CHECK_INTERVAL_MS) {
      this.announce();
      return;
    }
    let latest = record.latest;
    try {
      const tag = await deps.latestTag();
      latest = parseVersion(tag) ? tag : undefined;
    } catch {
      // Unreachable, refused, a redirect, a bad answer: keep what was known.
      // Turned off meanwhile (the request was aborted): record nothing.
      if (!deps.allowed()) return;
    }
    deps.store.write(
      latest === undefined
        ? { lastCheckedAt: now }
        : { lastCheckedAt: now, latest },
    );
    this.announce();
  }

  /** The newer release to show, if checks are allowed and there is one. */
  status(): AvailableUpdate | undefined {
    const { deps } = this;
    if (!deps.allowed()) return undefined;
    const { latest } = deps.store.read();
    if (latest === undefined || !isNewer(latest, deps.currentVersion))
      return undefined;
    const url = releasePageUrl(latest);
    return url === undefined
      ? undefined
      : { current: deps.currentVersion, latest, url };
  }

  private announce(): void {
    const update = this.status();
    if (update === undefined || update.latest === this.notified) return;
    this.notified = update.latest;
    this.deps.notify(update);
  }

  /** Settings changed: stop at once when no longer allowed, check when newly allowed. */
  settingsChanged(wasAllowed: boolean): void {
    const allowed = this.deps.allowed();
    if (wasAllowed && !allowed) this.deps.abort();
    if (!wasAllowed && allowed) void this.tick();
  }
}
