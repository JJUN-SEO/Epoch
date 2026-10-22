/*
 * Cost guardrails for scorers that call a paid model (CLAUDE.md "Bring your
 * own keys"). Prices are the user's own (per million tokens, from the
 * provider's price list); Epoch never ships prices. Before consent nothing
 * may leave the machine, so estimates are local: UTF-8 bytes / 2.5, a
 * deliberately high guess at tokens for source code (bytes, not characters,
 * so text in scripts like Chinese is not under-counted). Actual spend comes
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

const utf8 = new TextEncoder();

/** A high local estimate of the tokens in `text`. */
export const estimateTokens = (text: string): number =>
  Math.ceil(utf8.encode(text).length / 2.5);

export const costOf = (usage: Usage, prices: Prices): number =>
  (usage.inputTokens * prices.inputPerMTok +
    usage.outputTokens * prices.outputPerMTok) /
  1_000_000;

/**
 * What one request may cost, held against the cap from before it is sent
 * until it settles at its actual usage, or is released if it failed.
 */
export interface SpendHold {
  /** Counts the request's actual usage and frees the rest of the hold. */
  settle(usage: Usage): void;
  /** Frees the hold of a request that was not answered. */
  release(): void;
}

/**
 * Running spend against a cap. Each request reserves its worst case first,
 * so requests in flight together cannot pass the cap either.
 */
export class SpendCap {
  private spent = 0;
  private held = 0;
  private readonly maxUsd: number;
  private readonly prices: Prices;

  constructor(maxUsd: number, prices: Prices) {
    this.maxUsd = maxUsd;
    this.prices = prices;
  }

  get spentUsd(): number {
    return this.spent;
  }

  /** The worst cases of requests not yet settled. */
  get heldUsd(): number {
    return this.held;
  }

  get capUsd(): number {
    return this.maxUsd;
  }

  costOfUsage(usage: Usage): number {
    return costOf(usage, this.prices);
  }

  /** Holds a request's worst case; throws SpendCapReached if it could pass the cap. */
  reserve(worstCase: Usage): SpendHold {
    const amount = costOf(worstCase, this.prices);
    if (this.spent + this.held + amount > this.maxUsd) {
      throw new SpendCapReached(
        `the next request could cost up to $${amount.toFixed(4)}, which would pass the $${this.maxUsd.toFixed(2)} cap ($${this.spent.toFixed(4)} spent, $${this.held.toFixed(4)} held for requests in flight)`,
      );
    }
    this.held += amount;
    let open = true;
    const close = () => {
      if (!open) return false;
      open = false;
      this.held = Math.max(0, this.held - amount);
      return true;
    };
    return {
      settle: (usage) => {
        if (close()) this.spent += costOf(usage, this.prices);
      },
      release: () => {
        close();
      },
    };
  }
}
