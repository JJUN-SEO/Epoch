import { randomUUID } from "node:crypto";
import type {
  CachedSummary,
  KeyStatus,
  Settings,
  SpendStatus,
  StoredSummary,
  SummaryFailureReason,
  SummaryJobPlan,
  SummaryProgress,
  SummaryState,
  SummaryUnavailableReason,
} from "@epoch-dev/core";
import { priceOf } from "@epoch-dev/core";
import { costOf } from "@epoch-dev/scorers/cost";
import { ANTHROPIC_ORIGIN, OLLAMA_ORIGIN } from "@epoch-dev/scorers/origins";
import { SUMMARY_MAX_OUTPUT_TOKENS } from "@epoch-dev/scorers/summary";
import type { TextRequest, TextResult } from "@epoch-dev/scorers";
import type {
  SummaryJobItem,
  SummaryPlanMessage,
} from "../shared/host-protocol";
import type { ConsentStore } from "./consent-store";
import type { SummaryAnswer, SummaryModel } from "./host-client";
import type { SpendLedger, SpendLimits } from "./spend-ledger";

/*
 * When main sends anything for a summary (ADR-016). The analysis host plans
 * (reads the files, builds the prompt, knows what is stored) and stores the
 * sanitized answer; this decides whether to send, with what, and records
 * the cost. It never stores or forwards a prompt.
 *
 * - Fresh summaries are served without loading the model client.
 * - Automatic summaries (on open) run only when summaries are on, the
 *   project consented (or the model is on this machine), the worst case is
 *   under the ask-first threshold and both budgets, nothing else is being
 *   sent, and fewer than AUTO_PER_MINUTE ran in the last minute. A softly
 *   stale summary (only its dependencies changed) is never updated
 *   automatically.
 * - Everything else is a plan the user approves: a single-use id, bound to
 *   the window and project, rebuilt before sending; if the file or its
 *   worst case grew, the user is asked again. Consent for a remote provider
 *   is asked in main's own dialog.
 * - Each request reserves its worst case before it is sent, one at a time;
 *   requests for the same summary are merged; offline mode and Cancel abort
 *   what is in flight.
 */

/** What main needs from the window's analysis host. */
export interface SummaryContext {
  /** The window's web contents id: plans are bound to it. */
  readonly windowId: number;
  /** The open project, as main granted it. */
  readonly root: string;
  readonly host: {
    planSummary(
      root: string,
      subject: string,
      model: SummaryModel,
      withPrompt: boolean,
    ): Promise<SummaryPlanMessage>;
    storeSummary(
      root: string,
      key: string,
      answer: SummaryAnswer,
    ): Promise<StoredSummary | undefined>;
    summaryJob(
      root: string,
      dir: string,
      model: SummaryModel,
    ): Promise<SummaryJobItem[]>;
  };
  /** Progress of this window's jobs. */
  readonly notify: (p: SummaryProgress) => void;
}

/** The model client and egress, loaded only when something is sent. */
export interface SenderLike {
  generate(
    model: SummaryModel,
    apiKey: string | undefined,
    req: TextRequest,
  ): Promise<TextResult>;
  /** Aborts every request in flight (offline mode turned on). */
  abortAll(): void;
}

export interface SummaryServiceDeps {
  readonly settings: () => Settings;
  readonly keys: {
    status(provider: string): Promise<KeyStatus>;
    get(provider: string): Promise<string | undefined>;
  };
  readonly ledger: SpendLedger;
  readonly consent: ConsentStore;
  /** Main's native dialog: may this project's content go to the provider? */
  readonly askConsent: (
    ctx: SummaryContext,
    plan: SummaryJobPlan,
  ) => Promise<boolean>;
  readonly sender: () => Promise<SenderLike>;
}

const PLAN_TTL_MS = 10 * 60 * 1000;
const AUTO_PER_MINUTE = 6;
const MAX_LISTED = 200;
/** Floating-point slack when comparing dollars. */
const EPSILON = 1e-9;

interface Approved {
  readonly id: string;
  readonly windowId: number;
  readonly root: string;
  readonly subject: string;
  readonly model: SummaryModel;
  readonly plan: SummaryJobPlan;
  readonly createdAt: number;
  /** A single summary: the key it was planned with. A folder job: its items. */
  readonly key?: string;
  readonly items?: readonly SummaryJobItem[];
}

/** The model summaries use now; undefined when the local model is not chosen. */
function modelOf(settings: Settings): SummaryModel | undefined {
  const s = settings.summaries;
  if (s.provider === "local")
    return s.localModel === undefined
      ? undefined
      : { provider: "local", model: s.localModel };
  return { provider: "anthropic", model: s.model };
}

function metaOf(s: StoredSummary) {
  return {
    provider: s.provider,
    model: s.model,
    createdAt: s.createdAt,
    inputTokens: s.usage.inputTokens,
    outputTokens: s.usage.outputTokens,
    costUsd: s.usage.costUsd,
  };
}

function cachedOf(plan: SummaryPlanMessage): CachedSummary | undefined {
  if (!plan.ok || plan.status.state !== "stale") return undefined;
  return {
    text: plan.status.previous.text,
    stale: plan.status.why,
    meta: metaOf(plan.status.previous),
  };
}

const FAILURE_CODES = new Set<string>([
  "auth",
  "rate-limited",
  "unreachable",
  "server",
  "bad-request",
  "key-needs-workspace",
  "no-model",
]);

/** A text model's error as a reason code; never its message. */
function failureOf(err: unknown): SummaryFailureReason | "offline" {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String(err.code)
      : "";
  if (code === "offline") return "offline";
  if (code === "aborted") return "cancelled";
  if (FAILURE_CODES.has(code)) return code as SummaryFailureReason;
  return "server";
}

export class SummaryService {
  private readonly deps: SummaryServiceDeps;
  private readonly approved = new Map<string, Approved>();
  private readonly inflight = new Map<string, Promise<SummaryState>>();
  private readonly controllers = new Map<number, Set<AbortController>>();
  /** Bumped by Cancel: a run started before it counts as cancelled. */
  private readonly cancels = new Map<number, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private sending = 0;
  private autoTimes: number[] = [];
  private loadedSender: SenderLike | undefined;

  constructor(deps: SummaryServiceDeps) {
    this.deps = deps;
  }

  spend(): SpendStatus {
    return this.deps.ledger.status(this.limits(this.deps.settings()));
  }

  /** The user's reset: this month's spending starts over. */
  resetSpend(): void {
    this.deps.ledger.resetMonth();
  }

  /** Offline mode turned on aborts what is in flight. */
  settingsChanged(prev: Settings, next: Settings): void {
    if (prev.offline || !next.offline) return;
    this.loadedSender?.abortAll();
    for (const set of this.controllers.values()) for (const c of set) c.abort();
  }

  /** Stops this window's requests and job; what is done stays. */
  cancel(ctx: SummaryContext): Promise<void> {
    this.cancels.set(ctx.windowId, this.cancelsOf(ctx.windowId) + 1);
    for (const c of this.controllers.get(ctx.windowId) ?? []) c.abort();
    return Promise.resolve();
  }

  private cancelsOf(windowId: number): number {
    return this.cancels.get(windowId) ?? 0;
  }

  /** Whether Cancel was pressed in this window since now. */
  private cancelledSince(windowId: number): () => boolean {
    const start = this.cancelsOf(windowId);
    return () => this.cancelsOf(windowId) !== start;
  }

  async get(
    ctx: SummaryContext,
    subject: string,
    opts: { auto?: boolean } = {},
  ): Promise<SummaryState> {
    const settings = this.deps.settings();
    const model = modelOf(settings) ?? {
      provider: "local" as const,
      model: settings.summaries.model,
    };
    if (subject.startsWith("dir:"))
      return this.getFolder(ctx, subject, model, settings);
    const plan = await ctx.host.planSummary(ctx.root, subject, model, false);
    if (!plan.ok) return this.unavailable(subject, this.hostReason(plan));
    if (plan.status.state === "fresh") return this.ready(plan.status.summary);
    const cached = cachedOf(plan);
    const blocked = await this.availability(settings);
    if (blocked) return this.unavailable(subject, blocked, cached);
    const current = modelOf(settings);
    if (!current) return this.unavailable(subject, "no-local-model", cached);
    const jobPlan = this.jobPlan(current, [plan], settings);
    const remote = current.provider === "anthropic";
    const consented = !remote || this.deps.consent.has(ctx.root, "anthropic");
    const cheap =
      jobPlan.estimate.worstCaseUsd <= settings.spend.confirmAboveUsd + EPSILON;
    const soft =
      plan.status.state === "stale" && plan.status.why === "dependencies";
    if (
      opts.auto === true &&
      settings.summaries.auto &&
      consented &&
      cheap &&
      !soft
    ) {
      const key = this.flightKey(ctx, subject, current);
      const merged = this.inflight.get(key);
      if (merged) return merged;
      if (this.sending > 0 || !this.autoAllowed())
        return this.unavailable(subject, "busy", cached);
      this.autoTimes.push(Date.now());
      return this.runSingle(ctx, {
        id: "",
        windowId: ctx.windowId,
        root: ctx.root,
        subject,
        model: current,
        plan: jobPlan,
        createdAt: Date.now(),
        key: plan.key,
      });
    }
    const reason = !consented
      ? "consent"
      : !cheap
        ? "over-threshold"
        : "requested";
    return this.needsApproval(
      ctx,
      { subject, model: current, plan: jobPlan, key: plan.key },
      reason,
      cached,
    );
  }

  async generate(ctx: SummaryContext, planId: string): Promise<SummaryState> {
    const approved = this.approved.get(planId);
    this.approved.delete(planId);
    if (
      approved?.windowId !== ctx.windowId ||
      approved.root !== ctx.root ||
      Date.now() - approved.createdAt > PLAN_TTL_MS
    )
      return {
        state: "failed",
        subject: approved?.subject ?? "",
        reason: "expired",
      };
    const settings = this.deps.settings();
    const blocked = await this.availability(settings);
    if (blocked) return this.unavailable(approved.subject, blocked);
    const current = modelOf(settings);
    if (
      current?.provider !== approved.model.provider ||
      current.model !== approved.model.model
    )
      return {
        state: "failed",
        subject: approved.subject,
        reason: "plan-changed",
      };
    if (
      current.provider === "anthropic" &&
      !this.deps.consent.has(ctx.root, "anthropic")
    ) {
      if (!(await this.deps.askConsent(ctx, approved.plan)))
        return {
          state: "failed",
          subject: approved.subject,
          reason: "cancelled",
        };
      this.deps.consent.grant(ctx.root, "anthropic");
    }
    return approved.items
      ? this.runFolder(ctx, approved)
      : this.runSingle(ctx, approved);
  }

  /* ---------- internals ---------- */

  private limits(settings: Settings): SpendLimits {
    return {
      capUsd: settings.spend.monthlyCapUsd,
      sessionBudgetUsd: settings.spend.sessionBudgetUsd,
    };
  }

  /** Why nothing can be sent now, if anything stops it. */
  private async availability(
    settings: Settings,
  ): Promise<SummaryUnavailableReason | undefined> {
    if (!settings.summaries.enabled) return "disabled";
    const model = modelOf(settings);
    if (!model) return "no-local-model";
    if (model.provider === "local") return undefined;
    if (settings.offline) return "offline";
    if (!(await this.deps.keys.status("anthropic")).configured) return "no-key";
    if (!priceOf(settings, "anthropic", model.model)) return "no-price";
    const spend = this.deps.ledger.status(this.limits(settings));
    if (spend.monthUsd >= settings.spend.monthlyCapUsd - EPSILON)
      return "cap-reached";
    if (spend.sessionUsd >= settings.spend.sessionBudgetUsd - EPSILON)
      return "session-budget";
    return undefined;
  }

  private hostReason(
    plan: Extract<SummaryPlanMessage, { ok: false }>,
  ): SummaryUnavailableReason {
    return plan.reason === "children-missing" ? "not-supported" : plan.reason;
  }

  private worstCase(
    model: SummaryModel,
    inputTokens: number,
    requests: number,
    settings: Settings,
  ): number {
    if (model.provider === "local") return 0;
    const price = priceOf(settings, "anthropic", model.model);
    if (!price) return Number.POSITIVE_INFINITY;
    return costOf(
      { inputTokens, outputTokens: requests * SUMMARY_MAX_OUTPUT_TOKENS },
      price,
    );
  }

  private jobPlan(
    model: SummaryModel,
    items: readonly {
      readonly sends: readonly string[];
      readonly excluded: readonly string[];
      readonly inputTokens: number;
    }[],
    settings: Settings,
  ): SummaryJobPlan {
    const sends = [...new Set(items.flatMap((i) => i.sends))];
    const inputTokens = items.reduce((n, i) => n + i.inputTokens, 0);
    return {
      provider: model.provider,
      model: model.model,
      destination:
        model.provider === "anthropic" ? ANTHROPIC_ORIGIN : OLLAMA_ORIGIN,
      remote: model.provider === "anthropic",
      requests: items.length,
      sends: sends.slice(0, MAX_LISTED),
      sendsMore: Math.max(0, sends.length - MAX_LISTED),
      excluded: [...new Set(items.flatMap((i) => i.excluded))].sort(),
      estimate: {
        inputTokens,
        maxOutputTokens: items.length * SUMMARY_MAX_OUTPUT_TOKENS,
        worstCaseUsd: this.worstCase(
          model,
          inputTokens,
          items.length,
          settings,
        ),
      },
    };
  }

  private async getFolder(
    ctx: SummaryContext,
    subject: string,
    model: SummaryModel,
    settings: Settings,
  ): Promise<SummaryState> {
    const own = await ctx.host.planSummary(ctx.root, subject, model, false);
    if (own.ok && own.status.state === "fresh")
      return this.ready(own.status.summary);
    if (!own.ok && own.reason !== "children-missing")
      return this.unavailable(subject, this.hostReason(own));
    const cached = cachedOf(own);
    const blocked = await this.availability(settings);
    if (blocked) return this.unavailable(subject, blocked, cached);
    const current = modelOf(settings);
    if (!current) return this.unavailable(subject, "no-local-model", cached);
    const items = (
      await ctx.host.summaryJob(ctx.root, subject.slice(4), current)
    ).filter((i) => i.state === "todo");
    if (items.length === 0)
      return this.unavailable(subject, "not-supported", cached);
    return this.needsApproval(
      ctx,
      {
        subject,
        model: current,
        plan: this.jobPlan(current, items, settings),
        items,
      },
      "folder-job",
      cached,
    );
  }

  private needsApproval(
    ctx: SummaryContext,
    what: Pick<Approved, "subject" | "model" | "plan" | "key" | "items">,
    reason: Extract<SummaryState, { state: "needs-approval" }>["reason"],
    cached?: CachedSummary,
  ): SummaryState {
    const now = Date.now();
    for (const [id, a] of this.approved)
      if (now - a.createdAt > PLAN_TTL_MS) this.approved.delete(id);
    const id = randomUUID();
    this.approved.set(id, {
      ...what,
      id,
      windowId: ctx.windowId,
      root: ctx.root,
      createdAt: now,
    });
    return {
      state: "needs-approval",
      subject: what.subject,
      planId: id,
      plan: what.plan,
      reason,
      ...(cached ? { cached } : {}),
    };
  }

  private ready(s: StoredSummary): SummaryState {
    return {
      state: "ready",
      subject: s.subject,
      text: s.text,
      meta: metaOf(s),
    };
  }

  private unavailable(
    subject: string,
    reason: SummaryUnavailableReason,
    cached?: CachedSummary,
  ): SummaryState {
    return {
      state: "unavailable",
      subject,
      reason,
      ...(cached ? { cached } : {}),
    };
  }

  private autoAllowed(): boolean {
    const now = Date.now();
    this.autoTimes = this.autoTimes.filter((t) => now - t < 60_000);
    return this.autoTimes.length < AUTO_PER_MINUTE;
  }

  private flightKey(ctx: SummaryContext, subject: string, model: SummaryModel) {
    return `${ctx.root}\u0000${subject}\u0000${model.provider}:${model.model}`;
  }

  /** One request at a time, in the order asked. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private runSingle(ctx: SummaryContext, a: Approved): Promise<SummaryState> {
    const key = this.flightKey(ctx, a.subject, a.model);
    const merged = this.inflight.get(key);
    if (merged) return merged;
    this.sending++;
    const cancelled = this.cancelledSince(ctx.windowId);
    const run = this.exclusive(() =>
      this.sendOne(ctx, a, true, cancelled),
    ).finally(() => {
      this.sending--;
      this.inflight.delete(key);
    });
    this.inflight.set(key, run);
    return run;
  }

  /**
   * Plans again with the prompt, checks it against what was approved, then
   * reserves, sends, settles and stores.
   */
  private async sendOne(
    ctx: SummaryContext,
    a: Approved,
    checkDrift: boolean,
    cancelled: () => boolean,
  ): Promise<SummaryState> {
    if (cancelled())
      return { state: "failed", subject: a.subject, reason: "cancelled" };
    const settings = this.deps.settings();
    const plan = await ctx.host.planSummary(ctx.root, a.subject, a.model, true);
    if (!plan.ok) return this.unavailable(a.subject, this.hostReason(plan));
    if (plan.status.state === "fresh") return this.ready(plan.status.summary);
    const cached = cachedOf(plan);
    const worst = this.worstCase(a.model, plan.inputTokens, 1, settings);
    if (
      checkDrift &&
      (plan.key !== a.key || worst > a.plan.estimate.worstCaseUsd + EPSILON)
    )
      return this.needsApproval(
        ctx,
        {
          subject: a.subject,
          model: a.model,
          plan: this.jobPlan(a.model, [plan], settings),
          key: plan.key,
        },
        "requested",
        cached,
      );
    if (!plan.prompt)
      return this.unavailable(a.subject, "not-supported", cached);
    const remote = a.model.provider === "anthropic";
    const apiKey = remote ? await this.deps.keys.get("anthropic") : undefined;
    if (remote && apiKey === undefined)
      return this.unavailable(a.subject, "no-key", cached);
    const hold = this.deps.ledger.reserve(worst, this.limits(settings), remote);
    if (typeof hold === "string")
      return this.unavailable(a.subject, hold, cached);
    const controller = new AbortController();
    const set = this.controllers.get(ctx.windowId) ?? new Set();
    set.add(controller);
    this.controllers.set(ctx.windowId, set);
    let result: TextResult;
    try {
      this.loadedSender ??= await this.deps.sender();
      result = await this.loadedSender.generate(a.model, apiKey, {
        system: plan.prompt.system,
        user: plan.prompt.user,
        maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
        signal: controller.signal,
      });
    } catch (err) {
      hold.release();
      if (cancelled())
        return {
          state: "failed",
          subject: a.subject,
          reason: "cancelled",
          ...(cached ? { cached } : {}),
        };
      const reason = failureOf(err);
      if (reason === "offline" || (remote && this.deps.settings().offline))
        return this.unavailable(a.subject, "offline", cached);
      return {
        state: "failed",
        subject: a.subject,
        reason,
        ...(cached ? { cached } : {}),
      };
    } finally {
      set.delete(controller);
    }
    const price = priceOf(settings, "anthropic", a.model.model);
    const costUsd = remote && price ? costOf(result.usage, price) : 0;
    hold.settle(costUsd, result.usage);
    const failed = (reason: SummaryFailureReason): SummaryState => ({
      state: "failed",
      subject: a.subject,
      reason,
      ...(cached ? { cached } : {}),
    });
    if (result.stop === "refusal") return failed("refusal");
    if (result.stop === "max-tokens") return failed("cut-off");
    if (result.stop !== "end") return failed("server");
    let saved: StoredSummary | undefined;
    try {
      saved = await ctx.host.storeSummary(ctx.root, plan.key, {
        text: result.text,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd,
      });
    } catch {
      return failed("expired");
    }
    return saved ? this.ready(saved) : failed("nothing-kept");
  }

  /** A confirmed folder job: its items bottom-up, within its approved worst case. */
  private runFolder(ctx: SummaryContext, a: Approved): Promise<SummaryState> {
    const items = a.items ?? [];
    const cancelled = this.cancelledSince(ctx.windowId);
    return this.exclusive(async () => {
      this.sending++;
      let done = 0;
      let spentWorst = 0;
      const total = items.length;
      const progress = (state: SummaryProgress["state"], current?: string) => {
        ctx.notify({
          planId: a.id,
          state,
          done,
          total,
          ...(current ? { current } : {}),
          spentUsd: this.deps.ledger.status(this.limits(this.deps.settings()))
            .sessionUsd,
        });
      };
      try {
        for (const item of items) {
          if (cancelled()) {
            progress("cancelled");
            return { state: "failed", subject: a.subject, reason: "cancelled" };
          }
          progress("running", item.subject);
          const worst = this.worstCase(
            a.model,
            item.inputTokens,
            1,
            this.deps.settings(),
          );
          if (spentWorst + worst > a.plan.estimate.worstCaseUsd + EPSILON) {
            progress("failed");
            return {
              state: "failed",
              subject: a.subject,
              reason: "plan-changed",
            };
          }
          spentWorst += worst;
          const state = await this.sendOne(
            ctx,
            { ...a, subject: item.subject },
            false,
            cancelled,
          );
          if (cancelled()) {
            progress("cancelled");
            return { state: "failed", subject: a.subject, reason: "cancelled" };
          }
          if (state.state !== "ready") {
            progress("failed");
            return state.state === "failed"
              ? { ...state, subject: a.subject }
              : { state: "failed", subject: a.subject, reason: "plan-changed" };
          }
          done++;
        }
        progress("done");
        const own = await ctx.host.planSummary(
          ctx.root,
          a.subject,
          a.model,
          false,
        );
        return own.ok && own.status.state === "fresh"
          ? this.ready(own.status.summary)
          : { state: "failed", subject: a.subject, reason: "plan-changed" };
      } finally {
        this.sending--;
      }
    });
  }
}
