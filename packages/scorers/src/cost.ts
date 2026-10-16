/*
 * Cost guardrails for scorers that call a paid model (CLAUDE.md "Bring your
 * own keys"). Prices are the user's own (per million tokens, from the
 * provider's price list); Epoch never ships prices. Before consent nothing
 * may leave the machine, so estimates are local: characters / 2.5, a
 * deliberately high guess at tokens for source code. Actual spend comes
 * from the usage the provider reports.
 */

export interface Prices {
  /** USD per million input tokens. */
  readonly inputPerMTok: number;
  /** USD per million output tokens. */
  readonly outputPerMTok: number;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export class SpendCapReached extends Error {}

/** A high local estimate of the tokens in `text`. */
export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / 2.5);

export const costOf = (usage: Usage, prices: Prices): number =>
  (usage.inputTokens * prices.inputPerMTok +
    usage.outputTokens * prices.outputPerMTok) /
  1_000_000;

/** Running spend against a cap; refuses a request whose worst case would pass it. */
export class SpendCap {
  private spent = 0;
  private readonly maxUsd: number;
  private readonly prices: Prices;

  constructor(maxUsd: number, prices: Prices) {
    this.maxUsd = maxUsd;
    this.prices = prices;
  }

  get spentUsd(): number {
    return this.spent;
  }

  get capUsd(): number {
    return this.maxUsd;
  }

  costOfUsage(usage: Usage): number {
    return costOf(usage, this.prices);
  }

  /** Throws SpendCapReached if a request of this worst case could pass the cap. */
  reserve(worstCase: Usage): void {
    const next = this.spent + costOf(worstCase, this.prices);
    if (next > this.maxUsd) {
      throw new SpendCapReached(
        `the next request could cost up to $${costOf(worstCase, this.prices).toFixed(4)}, which would pass the $${this.maxUsd.toFixed(2)} cap ($${this.spent.toFixed(4)} spent)`,
      );
    }
  }

  record(usage: Usage): void {
    this.spent += costOf(usage, this.prices);
  }
}
