# ADR-015: Ordinal risk tiers replace the weighted risk score

- **Status:** Accepted (approved 2026-10-16). Supersedes CLAUDE.md "Risk score (v1 formula)" and the `riskScore` part of ADR-011.
- **Date:** 2026-10-16

## Context

Until now each file got `riskScore = 100 × (0.4 fanIn + 0.3 churn + 0.3 (1 − coverage))`, from percentile ranks across the repository (M4). Using the app, the maintainer found it artificial: "63.2" says nothing about why a file is risky or what to do, and percentile ranks call the top fifth of any repository risky, even a quiet one. The proposal was an ordinal matrix: a file is risky when change meets exposure or complexity, with plain thresholds and named archetypes.

Before deciding, a scratch analysis measured how the inputs are distributed and what each combination said about the future, on zod, vitest, Flask and cli/cli at T = HEAD − 180 days, labeling a file "fixed later" when a fix commit touched it in the next 180 days (Flask had none in that window). It found:

- With the proposed thresholds as first written (more than 5 dependents, any commit in 90 days, more than 300 lines), Critical files were fixed later 66% of the time against 6% for leaves, but High (31%) and Moderate (34%) did not differ. With "hot" meaning 3 or more commits, the order became monotonic: 80%, 47%, 37%, 22%, 9%.
- Its comparison with the old score used a simplified mapping (the warm rules left out) and counted commits of any size, so those numbers are superseded by the committed benchmark, below.

Because "3 or more" was chosen on that window, the evidence for this decision is a later, disjoint window (Decision 5 and "Measured").

## Decision

1. **Three facts, fixed thresholds** (defaults, tuned with evidence like `staleAfterDays`):
   - Exposure: **exposed** when more than 5 nodes depend on the file transitively, over blast radius's certain edge set (`type-only` included, hints and `via-barrel` not); else **contained**. Stored as `metrics.dependents` on every node, git or not.
   - Change: **hot** at 3 or more commits in the last 90 days, **warm** at 1–2, **quiet** at 0 (`churn90d`).
   - Fragility: **fragile** above 300 lines, or below 50% line coverage when a coverage report covers the file; else **sturdy**.
2. **Rules, first match wins**, so every combination has a tier:

   | Tier         | Archetype      | Rule                                           |
   | ------------ | -------------- | ---------------------------------------------- |
   | critical     | volatile-core  | exposed + hot + fragile                        |
   | high         | active-hotspot | exposed + hot, or exposed + warm + fragile     |
   | moderate     | warm-core      | exposed + warm                                 |
   | moderate     | fragile-leaf   | contained + hot, or contained + warm + fragile |
   | low-moderate | frozen-core    | exposed + quiet                                |
   | low          | stable-leaf    | everything else                                |

3. **No number.** `metrics.riskScore` is removed; `metrics.risk = { tier, archetype }` replaces it; `Graph.schemaVersion` becomes 2. Without git history there is no tier (as before, the UI says why).
4. **The UI shows the facts:** the details panel shows the tier, the archetype and what it means, and each fact with the side of its threshold it fell on ("Exposed: 238 files depend on it (exposed above 5)"). The Risk color mode colors by tier; a folder takes its riskiest file's tier. The CLI summary counts files per tier.
5. **Evidence is a committed benchmark**, `pnpm bench:risk` (docs/benchmarks/risk.md). Because "3 or more" was chosen looking at the exploration window, the benchmark's test is a **check window** that shares no data with it: T = HEAD − 360 days, labels from the next 180 days. Both windows are reported, the exploration one marked as reference only.

## Alternatives considered

- **Keep the score.** Rejected: the maintainer's point stands, and the measurements show no loss at the top without it.
- **Tiers from percentile buckets.** Rejected: a quiet repository would still get "critical" files.
- **Tiers plus the score as a tiebreak.** Rejected: two answers to one question, and the number comes back. Ties are ordered by dependents, then churn.
- **Different thresholds per language or repository size.** Not now: no evidence yet that they would help. The thresholds are defaults in one place (`RISK_DEFAULTS`).

## Consequences

- Risk is explainable in one line per fact; the archetype names give a vocabulary for review.
- Coarser ranking: five tiers cannot order files within a tier. Sorting falls back to dependents, then churn.
- Fix commits are a proxy for defects; the evaluation inherits its biases (commit message habits, squash merges).
- Measured results are in docs/benchmarks/risk.md, summarized below; re-run `pnpm bench:risk` after changing a threshold.

## Measured (docs/benchmarks/risk.md)

`pnpm bench:risk` on full clones of zod, vitest, Flask and cli/cli, 2026-10-16 (34 s for all eight analyses on a 4-core Xeon VM). Check window (T = HEAD − 360 days, labels from the next 180 days; no overlap with the window the thresholds were chosen on):

| Tier         | Fixed later, four repositories pooled |
| ------------ | ------------------------------------- |
| critical     | 81.4% (48 of 59)                      |
| high         | 50.0% (46 of 92)                      |
| moderate     | 33.1% (119 of 360)                    |
| low-moderate | 11.9% (44 of 371)                     |
| low          | 9.5% (197 of 2081)                    |

| Repository | Fixed later (base rate) | Top two tiers    | Same number of top v1 files | ROC AUC tiers / v1       |
| ---------- | ----------------------- | ---------------- | --------------------------- | ------------------------ |
| zod        | 7.0%                    | 53.8% (13 files) | 46.2%                       | 0.737 / 0.755            |
| vitest     | 17.4%                   | 78.6% (84 files) | 78.6%                       | 0.705 / 0.717            |
| cli/cli    | 15.5%                   | 41.7% (48 files) | 41.7%                       | 0.637 / 0.623            |
| Flask      | 2.4% (2 files)          | 16.7% (6 files)  | 16.7%                       | too few fixes to compare |

- The pooled order is monotonic, and so is each of vitest and cli/cli; in zod the small high (5 files) and low-moderate (61) tiers break it.
- At the top, the two riskiest tiers match the old score at the same cut in three repositories and beat it in zod. Over all files the two rank about equally (AUC within 0.02): tiers are not more accurate, they are as accurate where it matters and explain themselves.
- Frozen cores (low-moderate) are fixed later barely more often than stable leaves (11.9% vs 9.5% pooled). Exposure without change says little about near-term fixes; it still matters for blast radius. A candidate for tuning, not changed now.
- The exploration window, where "hot = 3 or more" was chosen, shows the same order (80.0%, 48.5%, 46.7%, 19.8%, 8.9%); reference only.
