import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SpendStatus } from "@epoch-dev/core";

/*
 * What model features spend (ADR-016): a monthly total, kept in Epoch's
 * data directory, and this session's total. Counts and dollars only, never
 * a path or any content. Each request reserves its worst case before it is
 * sent and settles its real cost after, so requests in flight can never
 * together pass a limit.
 */

export interface SpendLimits {
  /** Required before any paid request. */
  readonly capUsd?: number | undefined;
  readonly sessionBudgetUsd: number;
}

export type SpendRefusal = "no-cap" | "cap-reached" | "session-budget";

export interface SpendHold {
  settle(
    costUsd: number,
    usage: { readonly inputTokens: number; readonly outputTokens: number },
  ): void;
  release(): void;
}

const LedgerFile = z.object({
  version: z.literal(1),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  usd: z.number().nonnegative(),
  requests: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
type LedgerFile = z.infer<typeof LedgerFile>;

/** Floating-point slack when comparing sums of dollars. */
const EPSILON = 1e-9;

export class SpendLedger {
  private readonly file: string;
  private readonly now: () => Date;
  private data: LedgerFile;
  private sessionUsd = 0;
  private heldUsd = 0;

  constructor(file: string, now: () => Date = () => new Date()) {
    this.file = file;
    this.now = now;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      raw = undefined;
    }
    const parsed = LedgerFile.safeParse(raw);
    this.data = parsed.success ? parsed.data : this.empty();
  }

  private month(): string {
    return this.now().toISOString().slice(0, 7);
  }

  private empty(): LedgerFile {
    return {
      version: 1,
      month: this.month(),
      usd: 0,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  /** The stored month, started over when the calendar month changed (UTC). */
  private current(): LedgerFile {
    if (this.data.month !== this.month()) this.data = this.empty();
    return this.data;
  }

  status(limits: SpendLimits): SpendStatus {
    const data = this.current();
    return {
      month: data.month,
      monthUsd: data.usd,
      ...(limits.capUsd === undefined ? {} : { capUsd: limits.capUsd }),
      sessionUsd: this.sessionUsd,
      sessionBudgetUsd: limits.sessionBudgetUsd,
      heldUsd: this.heldUsd,
    };
  }

  /**
   * Reserves `worstUsd` for one request, or says which limit it would pass.
   * A model on this machine (`paid` false) costs nothing and needs no cap.
   */
  reserve(
    worstUsd: number,
    limits: SpendLimits,
    paid: boolean,
  ): SpendHold | SpendRefusal {
    const data = this.current();
    if (paid) {
      if (limits.capUsd === undefined) return "no-cap";
      if (data.usd + this.heldUsd + worstUsd > limits.capUsd + EPSILON)
        return "cap-reached";
      if (
        this.sessionUsd + this.heldUsd + worstUsd >
        limits.sessionBudgetUsd + EPSILON
      )
        return "session-budget";
    }
    const held = paid ? worstUsd : 0;
    this.heldUsd += held;
    let open = true;
    const close = () => {
      if (!open) return false;
      open = false;
      this.heldUsd = Math.max(0, this.heldUsd - held);
      return true;
    };
    return {
      settle: (costUsd, usage) => {
        if (!close()) return;
        const d = this.current();
        d.usd += costUsd;
        d.requests += 1;
        d.inputTokens += usage.inputTokens;
        d.outputTokens += usage.outputTokens;
        this.sessionUsd += costUsd;
        this.save();
      },
      release: () => {
        close();
      },
    };
  }

  /** The user's reset: this month's total starts over. */
  resetMonth(): void {
    this.data = this.empty();
    this.save();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
