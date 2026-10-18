import { describe, expect, it } from "vitest";
import {
  CHECK_INTERVAL_MS,
  UpdateChecker,
  type AvailableUpdate,
} from "./update-check";
import type { UpdateRecord } from "./update-store";

const DAY = CHECK_INTERVAL_MS;

function setup(
  opts: {
    record?: UpdateRecord;
    allowed?: boolean;
    answer?: () => Promise<string>;
    current?: string;
  } = {},
) {
  let record: UpdateRecord = opts.record ?? { lastCheckedAt: 0 };
  let allowed = opts.allowed ?? true;
  let now = 10 * DAY;
  const requests: number[] = [];
  const notices: AvailableUpdate[] = [];
  let aborts = 0;
  const checker = new UpdateChecker({
    now: () => now,
    allowed: () => allowed,
    currentVersion: opts.current ?? "0.1.0",
    latestTag: () => {
      requests.push(now);
      return (opts.answer ?? (() => Promise.resolve("v0.2.0")))();
    },
    abort: () => {
      aborts++;
    },
    store: {
      read: () => record,
      write: (r) => {
        record = r;
      },
    },
    notify: (u) => notices.push(u),
  });
  return {
    checker,
    requests,
    notices,
    record: () => record,
    aborts: () => aborts,
    advance: (ms: number) => {
      now += ms;
    },
    setNow: (t: number) => {
      now = t;
    },
    allow: (a: boolean) => {
      allowed = a;
    },
  };
}

describe("UpdateChecker", () => {
  it("asks nothing when update checks are off or offline mode is on", async () => {
    const t = setup({ allowed: false });
    await t.checker.tick();
    expect(t.requests).toEqual([]);
    expect(t.checker.status()).toBeUndefined();
  });

  it("asks once a day and tells the window about a newer release once", async () => {
    const t = setup();
    await t.checker.tick();
    expect(t.requests).toHaveLength(1);
    expect(t.notices).toEqual([
      {
        current: "0.1.0",
        latest: "v0.2.0",
        url: "https://github.com/JJUN-SEO/Epoch/releases/tag/v0.2.0",
      },
    ]);
    expect(t.record()).toEqual({ lastCheckedAt: 10 * DAY, latest: "v0.2.0" });
    t.advance(DAY - 1);
    await t.checker.tick();
    expect(t.requests).toHaveLength(1);
    t.advance(1);
    await t.checker.tick();
    expect(t.requests).toHaveLength(2);
    expect(t.notices).toHaveLength(1);
  });

  it("asks again when the clock went back", async () => {
    const t = setup({ record: { lastCheckedAt: 20 * DAY } });
    await t.checker.tick();
    expect(t.requests).toHaveLength(1);
  });

  it("merges ticks while a request is in flight", async () => {
    let finish: (tag: string) => void = () => undefined;
    const t = setup({
      answer: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const a = t.checker.tick();
    const b = t.checker.tick();
    finish("v0.2.0");
    await Promise.all([a, b]);
    expect(t.requests).toHaveLength(1);
  });

  it.each([
    ["the same version", () => Promise.resolve("v0.1.0")],
    ["an older version", () => Promise.resolve("v0.0.9")],
    ["a pre-release tag", () => Promise.resolve("v9.0.0-beta.1")],
    [
      "a failure (status, bad JSON, redirect)",
      () => Promise.reject(new Error("x")),
    ],
  ])("shows nothing for %s, and records the attempt", async (_name, answer) => {
    const t = setup({ answer });
    await t.checker.tick();
    expect(t.notices).toEqual([]);
    expect(t.record().lastCheckedAt).toBe(10 * DAY);
    expect(t.checker.status()).toBeUndefined();
  });

  it("keeps the last known release when a later check fails", async () => {
    const t = setup({
      record: { lastCheckedAt: 0, latest: "v0.3.0" },
      answer: () => Promise.reject(new Error("unreachable")),
    });
    await t.checker.tick();
    expect(t.record()).toEqual({ lastCheckedAt: 10 * DAY, latest: "v0.3.0" });
    expect(t.notices.map((n) => n.latest)).toEqual(["v0.3.0"]);
  });

  it("shows a newer release it already knows without asking, only while allowed", async () => {
    const t = setup({
      record: { lastCheckedAt: 10 * DAY - 5, latest: "v0.5.0" },
    });
    await t.checker.tick();
    expect(t.requests).toEqual([]);
    expect(t.notices.map((n) => n.latest)).toEqual(["v0.5.0"]);
    t.allow(false);
    expect(t.checker.status()).toBeUndefined();
  });

  it("aborts a request in flight when checks stop being allowed, and records nothing", async () => {
    let fail: (e: Error) => void = () => undefined;
    const t = setup({
      answer: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    });
    const pending = t.checker.tick();
    t.allow(false);
    t.checker.settingsChanged(true);
    expect(t.aborts()).toBe(1);
    fail(new Error("aborted"));
    await pending;
    expect(t.record()).toEqual({ lastCheckedAt: 0 });
  });

  it("checks as soon as checks are turned on", async () => {
    const t = setup({ allowed: false });
    t.allow(true);
    t.checker.settingsChanged(false);
    await t.checker.tick();
    expect(t.requests).toHaveLength(1);
  });

  it("offers nothing once this version is the latest", async () => {
    const t = setup({
      record: { lastCheckedAt: 10 * DAY, latest: "v0.2.0" },
      current: "0.2.0",
    });
    await t.checker.tick();
    expect(t.notices).toEqual([]);
  });
});
