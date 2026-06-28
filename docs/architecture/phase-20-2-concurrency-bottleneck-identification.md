# Phase 20.2 - Remaining Concurrency Bottleneck Identification

## Objective

Phase 20.2 identifies the remaining non-target concurrency bottleneck after Phase 20.1 without changing financial behavior, authority routing, write paths, event contracts, or schemas.

## Starting Point

Phase 20.1 cleared the wallet reservation and credit reserve/release evidence bottlenecks by reusing bounded read-only evidence snapshots inside the load-testing harness.

The remaining post-optimization baseline reported one non-target P95 bottleneck with slowest P95 near 1177.42ms.

## Methodology

The concurrency baseline now includes step-level timings for each scenario:

- Auth/session context.
- Wallet evidence.
- Ticket evidence.
- Settlement evidence.
- Credit evidence.
- RabbitMQ/outbox evidence.
- Database evidence.

Each step reports average latency, median latency, P95, P99, maximum latency, sample count, throughput/sec, error count, and result count. The bottleneck report ranks the top 10 slowest scenario/step pairs by P95, with P99 as a tie-breaker.

## Operations

Use:

```bash
npm run ops:concurrency-bottleneck-report
```

The report returns:

- Slowest scenario.
- Slowest concurrency level.
- Slowest step.
- P95/P99 ranking.
- Likely source.
- Optimization recommendation.
- Whether the fix is safe for the current phase.

## QA

Use:

```bash
npm run qa:concurrency-bottleneck-identification
```

The QA validates that the bottleneck report is generated, the slowest scenario and step are identified, P95/P99 breakdowns exist, authority state is unchanged, and financial counts are unchanged.

## Narrow Fixes Kept

No Phase 20.2 optimization is applied by default. This phase is diagnostic unless the remaining bottleneck is a narrow read-only evidence issue that is conclusively identified and safely measurable.

## Fixes Deferred

If the slowest source involves write behavior, financial invariants, reservation semantics, settlement, ledger, credit, event contracts, authority state, or schema/index decisions, the fix is deferred to Phase 20.3.

## Recommendation

Use the Phase 20.2 bottleneck report as the Phase 20.3 worklist. Optimize only the top confirmed read-only evidence path after repeat measurement.
