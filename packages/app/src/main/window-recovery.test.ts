import { describe, expect, it } from "vitest";
import { recoverWindow, type RecoveryTarget } from "./window-recovery";

type Gone = Parameters<Parameters<RecoveryTarget["onGone"]>[0]>[0];

/** A window whose events the test fires, recording what recovery did. */
function fakeWindow(
  answer: () => Promise<boolean> = () => Promise.resolve(true),
) {
  let gone: ((d: Gone) => void) | undefined;
  let unresponsive: (() => void) | undefined;
  let responsive: (() => void) | undefined;
  const calls = { reloads: 0, asked: 0, aborted: 0 };
  const target: RecoveryTarget = {
    onGone: (l) => (gone = l),
    onUnresponsive: (l) => (unresponsive = l),
    onResponsive: (l) => (responsive = l),
    reload: () => {
      calls.reloads++;
    },
    askReload: (signal) => {
      calls.asked++;
      signal.addEventListener("abort", () => {
        calls.aborted++;
      });
      return answer();
    },
  };
  return {
    target,
    calls,
    gone: (reason: Gone["reason"]) => gone?.({ reason, exitCode: 1 }),
    unresponsive: () => unresponsive?.(),
    responsive: () => responsive?.(),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("recoverWindow", () => {
  it("loads the UI again when the renderer crashes, not when it exits cleanly", () => {
    const w = fakeWindow();
    recoverWindow(w.target);
    w.gone("clean-exit");
    expect(w.calls.reloads).toBe(0);
    w.gone("crashed");
    w.gone("oom");
    expect(w.calls.reloads).toBe(2);
  });

  it("stops reloading a renderer that keeps crashing, and tries again later", () => {
    let now = 0;
    const w = fakeWindow();
    recoverWindow(w.target, { now: () => now, limit: 3, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) {
      w.gone("crashed");
      now += 1_000;
    }
    expect(w.calls.reloads).toBe(3);
    now += 60_000;
    w.gone("crashed");
    expect(w.calls.reloads).toBe(4);
  });

  it("asks before reloading a window that stopped responding", async () => {
    const w = fakeWindow(() => Promise.resolve(true));
    recoverWindow(w.target);
    w.unresponsive();
    w.unresponsive(); // one question at a time
    await settle();
    expect(w.calls.asked).toBe(1);
    expect(w.calls.reloads).toBe(1);
  });

  it("waits when asked to, and closes the question if the window recovers", async () => {
    const w = fakeWindow(() => Promise.resolve(false));
    recoverWindow(w.target);
    w.unresponsive();
    await settle();
    expect(w.calls.reloads).toBe(0);

    let answer: (reload: boolean) => void = () => undefined;
    const pending = fakeWindow(() => new Promise<boolean>((r) => (answer = r)));
    recoverWindow(pending.target);
    pending.unresponsive();
    pending.responsive();
    expect(pending.calls.aborted).toBe(1);
    answer(true); // the closed box reports a cancel; nothing reloads
    await settle();
    expect(pending.calls.reloads).toBe(0);
  });
});
