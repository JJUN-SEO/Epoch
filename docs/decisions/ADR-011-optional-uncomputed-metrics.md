# ADR-011: Uncomputed metrics are absent, not zero

- **Status:** Accepted; its `riskScore` part superseded by ADR-015 (risk tiers: `metrics.risk`, also absent until computed)
- **Date:** 2026-10-14
- **Milestone:** M1
- **Decided by:** Junhyuk Seo (project owner), during M1 planning

## Context

CLAUDE.md's `GraphNode.metrics` required `churn90d` and `riskScore`. Neither can be computed before M4: churn needs git history, and the risk score needs churn plus percentile ranking (CLAUDE.md "Risk score"). M1 still has to emit schema-valid graphs.

`coverage` was already optional, because it exists only when a coverage report is ingested.

## Options

1. **Emit `0` until M4.** No contract change. But every file would show churn 0 and risk 0, which reads as a measured value. CLAUDE.md says never to fabricate numbers, and the UI and CLI would have to remember which zeros are real.
2. **Make both optional, absent until computed.** A one-line contract change. It matches how `coverage` already works, and absence cannot be mistaken for a measurement.

## Decision

Option 2. `churn90d` and `riskScore` are optional in the `GraphNode.metrics` contract and in the zod schema. A value is present only when it was computed for that run; `fanIn` and `fanOut` stay required because M1 computes them.

## Consequences

- CLAUDE.md's `metrics` line changes in the same commit as this ADR.
- Consumers must handle absent values. The CLI summary and the later UI show "not computed" rather than a number.
- From M4, analyses that have usable git history always fill both. When history is unusable (not a repo, shallow clone), churn stays absent instead of being reported as zero, which is the honest outcome that `staleAfterDays` handling in M5 also relies on.
