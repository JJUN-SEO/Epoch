import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  applySettingsPatch,
  type Settings,
  type StoredSummary,
  type SummaryProgress,
} from "@epoch-dev/core";
import type {
  SummaryJobItem,
  SummaryPlanMessage,
} from "../shared/host-protocol";
import { ConsentStore } from "./consent-store";
import { SpendLedger } from "./spend-ledger";
import {
  SummaryService,
  type SenderLike,
  type SummaryContext,
} from "./summary-service";

/*
 * SummaryService decides when main sends anything for a summary (ADR-016).
 * The host and the sender are fakes: the host answers plans from a table,
 * the sender records each request and answers as told.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-summary-svc-"));
  dirs.push(dir);
  return path.join(dir, name);
}

const hex = (n: number) => n.toString(16).padStart(64, "0");
/** An error as the text models throw them: a reason code. */
const coded = (code: string, message: string = code) =>
  Object.assign(new Error(message), { code });

const stored = (
  subject: string,
  text = `About ${subject}.`,
): StoredSummary => ({
  subject,
  provider: "anthropic",
  model: "claude-haiku-5-5",
  promptVersion: 1,
  contentHash: "h",
  text,
  used: [],
  createdAt: "2026-10-17T00:00:00.000Z",
  usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
});

type Status = Extract<SummaryPlanMessage, { ok: true }>["status"];

function okPlan(
  subject: string,
  over: { key?: string; status?: Status; inputTokens?: number } = {},
): SummaryPlanMessage {
  return {
    ok: true,
    subject,
    kind: "file",
    key: over.key ?? hex(subject.length),
    status: over.status ?? { state: "missing" },
    used: 0,
    truncated: false,
    excluded: [],
    sends: [subject],
    inputTokens: over.inputTokens ?? 1000,
  };
}

function fakeHost() {
  const plans = new Map<string, SummaryPlanMessage>();
  const stores: { key: string; text: string; costUsd: number }[] = [];
  let job: SummaryJobItem[] = [];
  const host: SummaryContext["host"] = {
    planSummary: (_root, subject, _model, withPrompt) => {
      const p = plans.get(subject) ?? {
        ok: false as const,
        subject,
        reason: "not-in-graph" as const,
      };
      return Promise.resolve(
        p.ok && withPrompt
          ? { ...p, prompt: { system: "sys", user: `source of ${subject}` } }
          : p,
      );
    },
    storeSummary: (_root, key, answer) => {
      stores.push({ key, text: answer.text, costUsd: answer.costUsd });
      const subject = [...plans.values()].find(
        (p) => p.ok && p.key === key,
      )?.subject;
      if (!subject || answer.text.startsWith("```"))
        return Promise.resolve(undefined);
      const s = stored(subject, answer.text);
      plans.set(
        subject,
        okPlan(subject, { key, status: { state: "fresh", summary: s } }),
      );
      return Promise.resolve(s);
    },
    summaryJob: () => Promise.resolve(job),
  };
  return {
    host,
    plans,
    stores,
    setJob: (items: SummaryJobItem[]) => {
      job = items;
    },
  };
}

function fakeSender() {
  const calls: { user: string; key: string | undefined; provider: string }[] =
    [];
  let active = 0;
  let maxActive = 0;
  type Answer = (req: { signal?: AbortSignal }) => Promise<unknown>;
  const queue: Answer[] = [];
  const hanging: ((e: unknown) => void)[] = [];
  const sender: SenderLike = {
    async generate(model, apiKey, req) {
      calls.push({ user: req.user, key: apiKey, provider: model.provider });
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        const answer = queue.shift();
        if (answer)
          return (await answer(req)) as Awaited<
            ReturnType<SenderLike["generate"]>
          >;
        await new Promise((r) => setTimeout(r, 5));
        return {
          text: `Summary of ${req.user}.`,
          stop: "end" as const,
          usage: { inputTokens: 1000, outputTokens: 100 },
        };
      } finally {
        active--;
      }
    },
    abortAll() {
      for (const reject of hanging.splice(0)) reject(coded("offline"));
    },
  };
  return {
    sender,
    calls,
    maxActive: () => maxActive,
    /** A later request answers with what `run` returns or throws, in order. */
    answerNext: (run: () => Promise<unknown>) => {
      queue.push(run);
    },
    /** A later request waits until aborted (its signal, or abortAll). */
    hangNext: () => {
      queue.push(
        (req) =>
          new Promise((_, reject) => {
            hanging.push(reject);
            req.signal?.addEventListener("abort", () => {
              reject(coded("aborted"));
            });
          }),
      );
    },
  };
}

const ready: Settings = applySettingsPatch(DEFAULT_SETTINGS, {
  summaries: { enabled: true },
  prices: {
    "anthropic:claude-haiku-5-5": { inputPerMTok: 1, outputPerMTok: 5 },
  },
  spend: { monthlyCapUsd: 5, sessionBudgetUsd: 1, confirmAboveUsd: 0.05 },
});

function setup(
  opts: {
    settings?: Settings;
    key?: string | undefined;
    consent?: boolean;
  } = {},
) {
  let settings = opts.settings ?? ready;
  const host = fakeHost();
  const sender = fakeSender();
  const asked: number[] = [];
  const progress: SummaryProgress[] = [];
  let senderLoads = 0;
  const consent = new ConsentStore(tempFile("consent.json"));
  if (opts.consent) consent.grant("/p", "anthropic");
  const ledger = new SpendLedger(
    tempFile("spend.json"),
    () => new Date("2026-10-17T00:00:00Z"),
  );
  const key = "key" in opts ? opts.key : "test-key";
  const service = new SummaryService({
    settings: () => settings,
    keys: {
      status: () =>
        Promise.resolve(
          key === undefined ? { configured: false } : { configured: true },
        ),
      get: () => Promise.resolve(key),
    },
    ledger,
    consent,
    askConsent: (_ctx, plan) => {
      asked.push(plan.requests);
      return Promise.resolve(answerConsent);
    },
    sender: () => {
      senderLoads++;
      return Promise.resolve(sender.sender);
    },
  });
  let answerConsent = true;
  const ctx = (windowId = 1): SummaryContext => ({
    windowId,
    root: "/p",
    host: host.host,
    notify: (p) => progress.push(p),
  });
  return {
    service,
    host,
    sender,
    asked,
    progress,
    ledger,
    consent,
    ctx,
    senderLoads: () => senderLoads,
    setSettings: (s: Settings) => {
      const prev = settings;
      settings = s;
      service.settingsChanged(prev, s);
    },
    refuseConsent: () => {
      answerConsent = false;
    },
  };
}

describe("SummaryService", () => {
  it("sends nothing before consent, asked natively, and remembers it", async () => {
    const t = setup();
    t.host.plans.set("a.ts", okPlan("a.ts"));
    t.host.plans.set("b.ts", okPlan("b.ts"));
    const first = await t.service.get(t.ctx(), "a.ts", { auto: true });
    expect(first.state).toBe("needs-approval");
    expect(first.state === "needs-approval" && first.reason).toBe("consent");
    expect(t.senderLoads()).toBe(0);

    t.refuseConsent();
    const planId = first.state === "needs-approval" ? first.planId : "";
    const refused = await t.service.generate(t.ctx(), planId);
    expect(refused).toMatchObject({ state: "failed", reason: "cancelled" });
    expect(t.sender.calls).toEqual([]);
    expect(t.consent.has("/p", "anthropic")).toBe(false);

    const t2 = setup();
    t2.host.plans.set("a.ts", okPlan("a.ts"));
    t2.host.plans.set("b.ts", okPlan("b.ts"));
    const again = await t2.service.get(t2.ctx(), "a.ts", { auto: true });
    const done = await t2.service.generate(
      t2.ctx(),
      again.state === "needs-approval" ? again.planId : "",
    );
    expect(done.state).toBe("ready");
    expect(t2.asked).toEqual([1]);
    expect(t2.consent.has("/p", "anthropic")).toBe(true);
    // Consented and cheap: the next file is summarized on open, unasked.
    const auto = await t2.service.get(t2.ctx(), "b.ts", { auto: true });
    expect(auto.state).toBe("ready");
    expect(t2.asked).toEqual([1]);
    expect(t2.sender.calls.map((c) => c.user)).toEqual([
      "source of a.ts",
      "source of b.ts",
    ]);
    expect(t2.sender.calls.every((c) => c.key === "test-key")).toBe(true);
  });

  it("serves a fresh summary without loading the sender", async () => {
    const t = setup({ consent: true });
    t.host.plans.set(
      "a.ts",
      okPlan("a.ts", { status: { state: "fresh", summary: stored("a.ts") } }),
    );
    expect(await t.service.get(t.ctx(), "a.ts", { auto: true })).toMatchObject({
      state: "ready",
      text: "About a.ts.",
    });
    expect(t.senderLoads()).toBe(0);
  });

  it("never sends what the host refuses, such as a secret", async () => {
    const t = setup({ consent: true });
    t.host.plans.set("k.pem", {
      ok: false,
      subject: "k.pem",
      reason: "secret",
    });
    expect(await t.service.get(t.ctx(), "k.pem", { auto: true })).toEqual({
      state: "unavailable",
      subject: "k.pem",
      reason: "secret",
    });
    expect(t.senderLoads()).toBe(0);
  });

  it.each([
    [{ summaries: { enabled: false } }, "disabled"],
    [{ offline: true }, "offline"],
    [{ prices: { "anthropic:claude-haiku-5-5": null } }, "no-price"],
    [{ spend: { monthlyCapUsd: null } }, "no-cap"],
    [{ summaries: { provider: "local" as const } }, "no-local-model"],
  ])(
    "is unavailable with %j: %s, keeping the last text",
    async (patch, reason) => {
      const t = setup({
        settings: applySettingsPatch(ready, patch),
        consent: true,
      });
      t.host.plans.set(
        "a.ts",
        okPlan("a.ts", {
          status: {
            state: "stale",
            why: "file",
            previous: stored("a.ts", "Old."),
          },
        }),
      );
      const s = await t.service.get(t.ctx(), "a.ts", { auto: true });
      expect(s).toMatchObject({ state: "unavailable", reason });
      expect(s.state === "unavailable" && s.cached?.text).toBe("Old.");
      expect(t.senderLoads()).toBe(0);
    },
  );

  it("needs a key for a paid model", async () => {
    const t = setup({ key: undefined, consent: true });
    t.host.plans.set("a.ts", okPlan("a.ts"));
    expect(await t.service.get(t.ctx(), "a.ts", { auto: true })).toMatchObject({
      state: "unavailable",
      reason: "no-key",
    });
  });

  it("asks first above the threshold, and never updates a softly stale summary by itself", async () => {
    const t = setup({ consent: true });
    t.host.plans.set("big.ts", okPlan("big.ts", { inputTokens: 200_000 }));
    t.host.plans.set(
      "soft.ts",
      okPlan("soft.ts", {
        status: {
          state: "stale",
          why: "dependencies",
          previous: stored("soft.ts", "Still good."),
        },
      }),
    );
    const big = await t.service.get(t.ctx(), "big.ts", { auto: true });
    expect(big.state === "needs-approval" && big.reason).toBe("over-threshold");
    expect(
      big.state === "needs-approval" && big.plan.estimate.worstCaseUsd,
    ).toBeCloseTo(0.2 + 1024 * 5e-6);
    const soft = await t.service.get(t.ctx(), "soft.ts", { auto: true });
    expect(soft.state === "needs-approval" && soft.reason).toBe("requested");
    expect(soft.state === "needs-approval" && soft.cached).toMatchObject({
      text: "Still good.",
      stale: "dependencies",
    });
    expect(t.sender.calls).toEqual([]);
  });

  it("refuses past the monthly cap and the session budget, holds included", async () => {
    const tight = applySettingsPatch(ready, {
      spend: { monthlyCapUsd: 0.006, confirmAboveUsd: 1 },
    });
    const t = setup({ settings: tight, consent: true });
    t.host.plans.set("a.ts", okPlan("a.ts"));
    // Worst case: 1000 in + 1024 out = $0.00612, over the $0.006 cap.
    expect(await t.service.get(t.ctx(), "a.ts", { auto: true })).toMatchObject({
      state: "unavailable",
      reason: "cap-reached",
    });
    const budget = applySettingsPatch(ready, {
      spend: { sessionBudgetUsd: 0.006, confirmAboveUsd: 1 },
    });
    const u = setup({ settings: budget, consent: true });
    u.host.plans.set("a.ts", okPlan("a.ts"));
    expect(await u.service.get(u.ctx(), "a.ts", { auto: true })).toMatchObject({
      state: "unavailable",
      reason: "session-budget",
    });
    expect(t.sender.calls.length + u.sender.calls.length).toBe(0);
  });

  it("reserves the worst case before sending and settles the real cost after", async () => {
    const t = setup({ consent: true });
    t.host.plans.set("a.ts", okPlan("a.ts"));
    let heldWhileSending = -1;
    t.sender.answerNext(() => {
      heldWhileSending = t.service.spend().heldUsd;
      return Promise.resolve({
        text: "Prose.",
        stop: "end",
        usage: { inputTokens: 1000, outputTokens: 100 },
      });
    });
    expect((await t.service.get(t.ctx(), "a.ts", { auto: true })).state).toBe(
      "ready",
    );
    expect(heldWhileSending).toBeCloseTo(0.001 + 1024 * 5e-6);
    const spend = t.service.spend();
    expect(spend.heldUsd).toBe(0);
    expect(spend.monthUsd).toBeCloseTo(0.0015);
    expect(t.host.stores[0]?.costUsd).toBeCloseTo(0.0015);
  });

  it("approves exactly one plan, once, in its own window", async () => {
    const t = setup({ consent: true });
    t.host.plans.set("big.ts", okPlan("big.ts", { inputTokens: 200_000 }));
    const s = await t.service.get(t.ctx(), "big.ts", { auto: true });
    const planId = s.state === "needs-approval" ? s.planId : "";
    expect(await t.service.generate(t.ctx(2), planId)).toMatchObject({
      state: "failed",
      reason: "expired",
    });
    const s2 = await t.service.get(t.ctx(), "big.ts", { auto: false });
    const id2 = s2.state === "needs-approval" ? s2.planId : "";
    expect((await t.service.generate(t.ctx(), id2)).state).toBe("ready");
    expect(await t.service.generate(t.ctx(), id2)).toMatchObject({
      state: "failed",
      reason: "expired",
    });
    expect(t.sender.calls).toHaveLength(1);
  });

  it("asks again when the file or its cost changed after approval", async () => {
    const t = setup({ consent: true });
    t.host.plans.set("big.ts", okPlan("big.ts", { inputTokens: 200_000 }));
    const s = await t.service.get(t.ctx(), "big.ts", { auto: true });
    t.host.plans.set(
      "big.ts",
      okPlan("big.ts", { key: hex(99), inputTokens: 200_000 }),
    );
    const drift = await t.service.generate(
      t.ctx(),
      s.state === "needs-approval" ? s.planId : "",
    );
    expect(drift.state === "needs-approval" && drift.reason).toBe("requested");
    t.host.plans.set(
      "big.ts",
      okPlan("big.ts", { key: hex(99), inputTokens: 900_000 }),
    );
    const costlier = await t.service.generate(
      t.ctx(),
      drift.state === "needs-approval" ? drift.planId : "",
    );
    expect(costlier.state).toBe("needs-approval");
    expect(t.sender.calls).toEqual([]);
  });

  it("aborts what is in flight when offline mode is turned on", async () => {
    const t = setup({ consent: true });
    t.host.plans.set("a.ts", okPlan("a.ts"));
    t.sender.hangNext();
    const pending = t.service.get(t.ctx(), "a.ts", { auto: true });
    await new Promise((r) => setTimeout(r, 10));
    t.setSettings(applySettingsPatch(ready, { offline: true }));
    expect(await pending).toMatchObject({
      state: "unavailable",
      reason: "offline",
    });
    expect(t.service.spend()).toMatchObject({ heldUsd: 0, monthUsd: 0 });
    expect(t.host.stores).toEqual([]);
  });

  it("merges requests for the same summary, and sends one at a time", async () => {
    const t = setup({ consent: true });
    for (const f of ["a.ts", "b.ts"]) t.host.plans.set(f, okPlan(f));
    const results = await Promise.all([
      t.service.get(t.ctx(), "a.ts", { auto: true }),
      t.service.get(t.ctx(), "a.ts", { auto: true }),
      t.service
        .get(t.ctx(), "b.ts", { auto: false })
        .then((s) =>
          t.service.generate(
            t.ctx(),
            s.state === "needs-approval" ? s.planId : "",
          ),
        ),
    ]);
    expect(results.map((r) => r.state)).toEqual(["ready", "ready", "ready"]);
    expect(t.sender.calls.map((c) => c.user)).toEqual([
      "source of a.ts",
      "source of b.ts",
    ]);
    expect(t.sender.maxActive()).toBe(1);
  });

  it("reports failures as fixed codes, stores nothing for a refusal or a cut-off answer", async () => {
    for (const [answer, reason] of [
      [() => Promise.reject(coded("auth", "secret detail")), "auth"],
      [
        () =>
          Promise.resolve({
            text: "No.",
            stop: "refusal",
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        "refusal",
      ],
      [
        () =>
          Promise.resolve({
            text: "Half",
            stop: "max-tokens",
            usage: { inputTokens: 1, outputTokens: 1024 },
          }),
        "cut-off",
      ],
      [
        () =>
          Promise.resolve({
            text: "```\ncode\n```",
            stop: "end",
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
        "nothing-kept",
      ],
    ] as const) {
      const t = setup({ consent: true });
      t.host.plans.set("a.ts", okPlan("a.ts"));
      t.sender.answerNext(answer);
      const s = await t.service.get(t.ctx(), "a.ts", { auto: true });
      expect(s).toEqual({ state: "failed", subject: "a.ts", reason });
      expect(JSON.stringify(s)).not.toContain("secret detail");
    }
  });

  it("runs a model on this machine without consent, a price or a cap", async () => {
    const local = applySettingsPatch(DEFAULT_SETTINGS, {
      offline: true,
      summaries: { enabled: true, provider: "local", localModel: "qwen3:4b" },
    });
    const t = setup({ settings: local, key: undefined });
    t.host.plans.set("a.ts", okPlan("a.ts"));
    expect((await t.service.get(t.ctx(), "a.ts", { auto: true })).state).toBe(
      "ready",
    );
    expect(t.asked).toEqual([]);
    expect(t.sender.calls[0]).toMatchObject({
      provider: "local",
      key: undefined,
    });
    expect(t.host.stores[0]?.costUsd).toBe(0);
  });

  it("runs a confirmed folder job bottom-up, with progress, and stops on cancel keeping what is done", async () => {
    const t = setup({ consent: true });
    for (const f of ["src/a.ts", "src/b.ts", "src/c.ts"])
      t.host.plans.set(f, okPlan(f));
    t.host.plans.set("dir:src", {
      ok: false,
      subject: "dir:src",
      reason: "children-missing",
      missing: ["src/a.ts"],
    });
    t.host.setJob([
      {
        subject: "src/a.ts",
        state: "todo",
        inputTokens: 1000,
        sends: ["src/a.ts"],
        excluded: [],
      },
      {
        subject: "src/b.ts",
        state: "todo",
        inputTokens: 1000,
        sends: ["src/b.ts"],
        excluded: [],
      },
      {
        subject: "src/c.ts",
        state: "todo",
        inputTokens: 1000,
        sends: ["src/c.ts"],
        excluded: [],
      },
      {
        subject: "dir:src",
        state: "todo",
        inputTokens: 3000,
        sends: [],
        excluded: [],
      },
    ]);
    const s = await t.service.get(t.ctx(), "dir:src", { auto: true });
    expect(s.state === "needs-approval" && s.reason).toBe("folder-job");
    expect(s.state === "needs-approval" && s.plan).toMatchObject({
      requests: 4,
      sends: ["src/a.ts", "src/b.ts", "src/c.ts"],
      estimate: { inputTokens: 6000, maxOutputTokens: 4 * 1024 },
    });
    expect(t.sender.calls).toEqual([]);
    // The first file answers; the second hangs until the job is cancelled.
    t.sender.answerNext(() =>
      Promise.resolve({
        text: "A.",
        stop: "end",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );
    t.sender.hangNext();
    const job = t.service.generate(
      t.ctx(),
      s.state === "needs-approval" ? s.planId : "",
    );
    await new Promise((r) => setTimeout(r, 30));
    await t.service.cancel(t.ctx());
    const end = await job;
    expect(end.state).toBe("failed");
    expect(end.state === "failed" && end.reason).toBe("cancelled");
    expect(t.host.stores.map((x) => x.text)).toEqual(["A."]);
    expect(t.progress.at(-1)).toMatchObject({
      state: "cancelled",
      done: 1,
      total: 4,
    });
  });
});
