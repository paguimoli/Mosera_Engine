# PR-05A Downstream Latency and Connection-Budget Remediation

Status: `PR_05A_DOWNSTREAM_LATENCY_CONNECTION_BUDGET_BLOCKED`

PR-05A used short diagnostic campaigns only. It makes no sustained-load or
capacity claim, and it did not activate either pilot product for production.
All failed and diagnostic evidence remains under `.qa/pr-05` and `.qa/pr-05a`.

## Baseline

The first instrumented diagnostic completed 203 due items with exact financial
reconciliation and no duplicate effects. Its principal measurements were:

- draw due to authoritative result p95: 254.53 ms
- result to evaluation p95: 2,208.81 ms
- SettlementInput to Settlement p95: 4,007.79 ms
- Settlement to Ledger p95: 383.37 ms
- Ledger to Wallet p95: 108.59 ms
- authoritative result to Wallet p95: 5,286.77 ms
- PostgreSQL peak: 100 connections, 17 active, 6 lock waiters

The evidence separated queue delay from processing time and confirmed that the
draw provider, Ledger, and Wallet execution were not the primary bottlenecks.

## Remediation Retained

- Node repositories in one process reuse bounded application or worker pools.
- All pools carry explicit application names and bounded sizes.
- .NET services normalize `DATABASE_URL` with explicit maximum pool sizes and
  application names.
- The ordinary worker pool is 2 connections, the application pool is 6, and
  the Settlement worker pool/prefetch is 14.
- The outbox dispatcher uses bounded batches and backlog-aware polling, and
  aggregates successful observability writes by event type per cycle.
- RabbitMQ consumer prefetch is explicit and workload-specific.
- Scheduler evaluation persistence may execute concurrently while preserving
  deterministic item order for ticket-cap planning and SettlementInput creation.
- Canonical Settlement commits its immutable request claim before calling
  Settlement, Ledger, and Wallet authorities, then writes completion evidence in
  a second transaction. No database transaction spans remote authority calls.
- Migration 141 records immutable downstream publication, consumption, start,
  and completion timestamps. Migration 140 remains intact.

## Connection Budget

The pre-remediation Node topology created independent repository pools, commonly
with a default maximum of 10. Because multiple repositories exist in each app or
worker process, the topology had no defensible process-level ceiling and reached
all 100 local PostgreSQL connections.

The bounded normal runtime envelope is:

| Component | Replicas | Pool max | Budget |
| --- | ---: | ---: | ---: |
| Next.js application | 1 | 6 | 6 |
| Outbox plus ordinary Node workers | 8 | 2 | 16 |
| Settlement Node worker | 1 | 14 | 14 |
| Auth Service | 1 | 4 | 4 |
| Game Engine | 1 | 8 | 8 |
| Settlement Service | 1 | 8 | 8 |
| Ledger Service | 1 | 6 | 6 |
| Credit Wallet Service | 1 | 6 | 6 |
| **Normal runtime total** | | | **68** |
| **Reserved headroom** | | | **32** |

The PR-05 qualification harness adds a four-connection harness pool and two
temporary Game Engine processes. Those processes are diagnostic overhead, not
part of the normal production topology, but they must still be budgeted during
qualification.

A representative retained run with the Settlement worker at 14 observed 73
connections, 13 active connections, and zero lock waiters. It completed 153 due
items with exact reconciliation and no duplicates, but authoritative result to
Wallet p95 remained 6,368 ms.

## Remaining Root Cause

Fast Keno keeps one Math Evaluation Certificate per wager item, then currently
fans every item into an independent Settlement request. Multiple requests for
one ticket compete to mutate the same reservation and completion state. Raising
concurrency increases row-lock and connection pressure; serializing by ticket
removes unsafe contention but makes a ticket with many derived wagers take too
long.

The final ticket-serialization diagnostic is retained as campaign
`pr05a-ticket-ordered-20260827T1625Z`. It completed all 208 due items with exact
reconciliation and zero duplicate effects, but measured:

- result to evaluation p95: 5,041.33 ms
- SettlementInput to Settlement p95: 7,024.85 ms
- authoritative result to Wallet p95: 9,180.91 ms
- PostgreSQL peak: 83 connections, 26 active, 10 lock waiters

The unsuccessful ticket-serialization runtime change was removed after this
diagnostic. Its evidence was not deleted.

## Required Material Design

Closing the latency gate requires an additive ticket/draw aggregate settlement
contract and therefore must be reviewed before implementation:

1. Preserve every per-item Math Evaluation Certificate.
2. Once all due items for one ticket/draw participation are evaluated, create
   one immutable aggregate SettlementInput referencing the ordered certificate
   IDs/hashes and the ticket-level cap/refund allocation.
3. Publish one Settlement request per ticket/draw participation.
4. Apply one reservation mutation and one Wallet effect for that aggregate;
   retain item-level references in canonical Ledger detail.
5. Bind idempotency to ticket, draw, immutable product/math/paytable/evaluator
   versions, and the aggregate payload hash.
6. Keep each multi-draw participation independent and append-only. Recovery,
   correction, reversal, and replay must never mutate prior evidence.
7. Complete the parent ticket only after all participation aggregates are
   terminal.

This preserves authority boundaries and financial evidence while removing the
N-to-1 reservation contention. Implementing it is outside PR-05A because it is
a material cross-authority contract change.

## Decision

The connection-budget blocker is credibly remediated for the normal topology.
The Result-to-Wallet latency blocker remains unresolved. A managed 30-minute
PR-05 rerun must not begin until the aggregate settlement design is approved,
implemented, and proven by focused correctness and diagnostic latency QA.
