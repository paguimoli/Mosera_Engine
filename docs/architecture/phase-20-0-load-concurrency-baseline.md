# Phase 20.0 - Load and Concurrency Baseline

## Objective

Phase 20.0 establishes the first production-engineering concurrency baseline for the extracted financial authority architecture. It measures current behavior only. It does not optimize, tune, change authority, change routing, change financial logic, or mutate financial records.

## Methodology

The baseline uses protected operations APIs and read-only concurrent evidence probes. Each scenario executes at the required concurrency levels and records latency distribution, throughput, failures, timeouts, retries, conflicts, duplicate indicators, queue growth, CPU, and memory.

Write-heavy workloads are represented by read-only evidence probes in this phase so financial totals remain unchanged:

- Authentication uses session-context evidence reads.
- Wallet reservation and credit reserve/release cycles use `credit_reservations` evidence reads.
- Ticket purchase concurrency uses `tickets` evidence reads.
- Settlement processing uses `credit_settlement_applications` evidence reads.
- RabbitMQ uses outbox and queue evidence.
- Database concurrency uses ledger evidence reads.

## Workloads

| Scenario | Concurrency levels | Measurement mode |
| --- | --- | --- |
| Concurrent player authentication | 10, 25, 50, 100 | Read-only baseline |
| Wallet reservations | 50, 100, 250, 500 | Read-only baseline |
| Ticket purchases | 25, 50, 100, 250 | Read-only baseline |
| Settlement processing | 10, 25, 50, 100 | Read-only baseline |
| Credit reserve/release cycles | 25, 50, 100, 250 | Read-only baseline |
| RabbitMQ | 10, 25, 50, 100 | Read-only baseline |
| Database | 10, 25, 50, 100 | Read-only baseline |

## Critical Invariants

The baseline verifies:

- Settlement remains `SERVICE / CERTIFIED`.
- Ledger remains `SERVICE / CERTIFIED`.
- Credit remains `SERVICE / CERTIFIED`.
- Comparison remains `ENABLED`.
- Rollback remains `READY`.
- Financial totals remain unchanged.
- No duplicate ticket, settlement, ledger, or credit reservation evidence is introduced by the test.
- Outbox and event ordering remain advisory-clean.
- Idempotency evidence remains preserved.

## APIs

- `GET /api/operations/load-test-status`
- `GET /api/operations/concurrency-baseline`
- `GET /api/operations/load-summary`

All APIs require `system.admin`.

## Operations

Run:

```sh
npm run ops:concurrency-baseline
npm run ops:load-summary
```

## QA

Run:

```sh
npm run qa:concurrency-baseline
```

The QA validates protected APIs, measurement-only behavior, scenario coverage, latency/throughput output, unchanged authority state, unchanged financial counts, and invariant preservation.

## Measured Limits

Phase 20.0 records observed limits without tuning them. The results from `ops:concurrency-baseline` are the official comparison point for Phase 20.1.

## Observed Bottlenecks

Bottlenecks are reported automatically for scenario concurrency levels with high p95 latency or failures.

## No Optimizations

No index, schema, cache, routing, authority, queue, worker, dispatcher, wallet, settlement, ledger, or credit calculation optimization is introduced in this phase.

## Recommendations

Phase 20.1 should use the Phase 20.0 baseline to select one measured bottleneck and optimize only that target with before/after validation.
