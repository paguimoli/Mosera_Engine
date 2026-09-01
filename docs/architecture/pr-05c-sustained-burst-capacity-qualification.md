# PR-05C Sustained and Burst Capacity Qualification

## 1. Executive Summary

PR-05C is **blocked**. The 100-player, 30-minute baseline completed and passed. A
500-player, 30-minute execution completed the canonical financial chain with exact
accounting and no duplicate or cross-player effects, but one ticket-acceptance
deadlock made that execution ineligible as a passing tier. The bounded retry repair
was followed by an execution with a 15 minute 31 second metrics gap, so that run is
not continuous sustained evidence. No burst tier was executed and no burst or pilot
capacity claim is made.

## 2. Starting Repository State

The campaign started from committed baseline
`8a474adcceda180377f9889ae269835d1b6aac95` with the uncommitted PR-04B, PR-04C,
PR-05A, and PR-05B stack preserved. The unrelated dirty files
`scripts/operations/local-runtime-inventory.mjs` and
`scripts/qa/local-integrated-runtime.mjs` were not modified for PR-05C.

## 3. Campaign IDs

The principal retained execution is `pr05c-20260828T043600Z-rerun6`. Earlier and
later executions remain separately preserved under `.qa/pr-05c/`, including
`pr05c-20260828T054300Z-rerun7`, whose metric observations jump from
`2026-08-28T05:45:28.655Z` to `2026-08-28T06:00:59.158Z`.

## 4. Qualification Environment

- Host: macOS 25.6.0, Intel i9-9980HK, 16 logical CPUs, 64 GiB RAM.
- Node: 20.20.2; .NET SDK: 10.0.301.
- PostgreSQL: 16.14, `max_connections=100`, fresh `lottery_disposable` database.
- RabbitMQ: 3.13.7; Redis: 7.4.9.
- Game Engine: two host instances, pool 16 and fanout concurrency 16 each.
- Settlement: service pool 8; worker pool/prefetch 18.
- Qualification harness pool: 4.

Capacity observations apply only to this local Docker Desktop environment.

## 5. Fresh Database Verification

All 143 migrations were applied from zero. Migration validation passed 1,385
checks with zero failures. No production or staging migration guardrail was relaxed.

## 6. Preflight Result

Preflight passed aggregate settlement, Hot Spot multi-draw, durable scheduler,
pilot-product, Game Engine, Settlement, exact chain, idempotency, and teardown
checks. The production activation path remained disabled.

## 7. 10,000-Player Population Model

The harness provisions distinct account, player, and Wallet identities for up to
10,000 players. It uses casual/light, normal active, highly active, and burst-heavy
cohorts with jitter rather than a shared-player shortcut.

## 8. Activity Distribution

Traffic is nonuniform, including low/normal/high balances, near-insufficient funds,
pending exposure, high-stake tails, and cycle/cutoff timing. Funds become reusable
only after committed Wallet evidence.

## 9. Tenant/Brand Distribution

Two tenants, two brands, and two markets were represented. Cross-player and
cross-scope contamination remained zero in completed sustained evidence.

## 10. Product Traffic Mix

Baseline accepted 754 Fast Keno and 280 Hot Spot tickets (72.9%/27.1%). Pilot
accepted 2,160 Fast Keno and 757 Hot Spot tickets (74.0%/26.0%).

## 11. Fast Keno Wager Distribution

All 19 derived markets, opposing wagers, varied ticket sizes, and low-skewed stake
values with a high tail were included. Aggregate settlement applies the configured
$10,000 cap once per ticket/draw, after item evaluation.

## 12. Hot Spot Workload Distribution

Spot counts 1-10, manual/Quick Pick, Bullseye on/off, varied stakes and plays, and
1/5/10/20 multi-draw purchases were covered. Full cost is reserved once and each
bound draw participation settles independently.

## 13. Real CSPRNG Verification

Sustained outcomes used `INTERNAL_CSPRNG`; no deterministic fallback was used.
Provider/configuration evidence remained version-bound.

## 14. Stage-Timing Instrumentation

Evidence covers due detection, claim, provider start/execution, outcome persistence,
certificate issuance, Math, aggregate, Settlement, Ledger, Wallet, and Completion.

## 15. Raw CSPRNG Latency

Baseline provider execution p50/p95/p99/max was
`4.30/8.65/55.34/55.34 ms`; pilot was `2.79/6.46/9.88/9.88 ms`.

## 16. Scheduled Draw to Authoritative Result

Baseline p50/p95/p99/max was `363.91/607.02/955.33/955.33 ms`. Pilot was
`320.17/717.64/1300.45/1300.45 ms`.

## 17. Ticket Acceptance

Baseline p50/p95/p99/max was `56.81/212.28/489.64/790.63 ms`. Pilot was
`74.29/346.56/627.08/1671.42 ms`.

## 18. Result to Math

Baseline p50/p95/p99/max was `234.82/2066.36/4171.55/4379.68 ms`. Pilot was
`541.29/7092.11/11955.98/14576.52 ms`.

## 19. Math to Aggregate

Baseline p50/p95/p99/max was `19.07/71.89/112.28/236.13 ms`. Pilot was
`14.64/105.95/200.54/388.32 ms`.

## 20. Aggregate to Settlement

Baseline p50/p95/p99/max was `664.37/3439.07/5049.26/5684.11 ms`. Pilot was
`1073.32/3633.57/5926.06/13188.07 ms`.

## 21. Settlement to Ledger

Baseline p50/p95/p99/max was `133.57/262.20/978.15/1296.18 ms`. Pilot was
`127.02/231.71/294.61/614.62 ms`.

## 22. Ledger to Wallet

Baseline p50/p95/p99/max was `0/215.75/347.57/636.26 ms`. Pilot was
`0/211.69/299.30/478.38 ms`.

## 23. Wallet to Completion

Baseline p50/p95/p99/max was `59.43/1933.96/3550.88/959772.82 ms`. Pilot was
`63.93/2181.48/4141.76/959625.62 ms`. The extreme maxima are retained anomalies
from delayed parent completion evidence and are not hidden by percentile results.

## 24. Result to Wallet

Baseline p50/p95/p99/max was `1190.03/5097.81/6604.73/7225.24 ms`. Pilot was
`1893.78/10372.42/16296.12/18340.92 ms`. Both p95 values exceeded the 5-second
super-max objective and are retained as latency findings.

## 25. Result to Completion

Baseline p50/p95/p99/max was `1258.29/6133.38/7005.97/961511.80 ms`. Pilot was
`2016.41/11461.45/17256.29/961708.98 ms`.

## 26. Tier A: 100 Players, 30 Minutes

**PASS / BASELINE_SUSTAINED_VERIFIED.** 1,034 tickets, 2,797 items, 1,285
aggregate financial units, 71 Fast Keno draws, 7 Hot Spot draws, zero missed draws,
zero schedule drift, exact accounting, and zero duplicate/contamination evidence.

## 27. Tier B: 500 Players, 30 Minutes

**NOT VERIFIED.** The retained run completed 2,917 tickets, 8,095 items, 3,716
aggregate financial units, 71 Fast Keno draws and 8 Hot Spot draws with exact
accounting and zero duplicate/contamination evidence. One acceptance transaction
ended on a PostgreSQL deadlock, so the tier failed. A bounded idempotent retry was
added, but its requalification run was non-continuous.

## 28. Tier C: 2,000 Players, 60 Minutes

Not executed because Tier B did not pass.

## 29. Sustained Draw Counts

Tier A: 71 Fast Keno and 7 Hot Spot authoritative draws. Tier B retained evidence:
71 Fast Keno and 8 Hot Spot authoritative draws. Neither run missed an overload draw.

## 30. Sustained Tickets per Draw

The baseline averaged approximately 14.6 accepted tickets per Fast Keno cycle when
all accepted traffic is normalized across 71 cycles. Pilot retained evidence averaged
approximately 41.1. These are descriptive, not capacity ceilings.

## 31. Sustained Wagers per Ticket

Baseline averaged 2.70 items per ticket; pilot averaged 2.78. Distribution included
the configured short, medium, long, and occasional 20-wager Fast Keno tickets.

## 32. Backlog Trend by Tier

Fast Keno due-but-unexecuted and recovery-required counts ended at zero. Remaining
Hot Spot unsettled counts represented valid future multi-draw exposure. Because Tier
B did not pass and no burst executed, only baseline is classified stable/clearing.

## 33. 500-Ticket Burst

Not executed.

## 34. 1,000-Ticket Burst

Not executed.

## 35. 2,500-Ticket Burst

Not executed.

## 36. 5,000-Ticket Burst

Not executed.

## 37. 10,000-Ticket Stress Burst

Not executed.

## 38. Highest Sustainable Tickets per Draw

No burst capacity is claimed. The highest sustained classification is the 100-player
baseline; descriptive per-draw averages must not be interpreted as burst support.

## 39. Evaluations per Draw at Capacity

No burst capacity point was established. Baseline processed 2,733 due item Math
certificates across its completed authoritative outcomes.

## 40. Aggregate Settlements per Draw at Capacity

No burst capacity point was established. Baseline completed 1,285 aggregate
financial units.

## 41. Next-Draw Pending-Fund Evidence

Pending exposure was not reusable. Baseline cutoff evidence reconciled 21,909,700
minor units captured and 110,700 future; pilot cutoff evidence reconciled 68,864,500
captured and 235,200 future.

## 42. Hot Spot Under Burst Pressure

Not burst-qualified. Sustained and focused QA preserved Quick Pick, Bullseye,
multi-draw, per-play cap, future exposure, cancellation, retry, and completion rules.

## 43. PostgreSQL Connections and Lock Waits

The final tested budget was 100 server connections with Game Engine pools 16+16,
Settlement service pool 8, Settlement worker pool 18, and harness pool 4. A previous
24+24+24 execution hit `53300 too many clients`; that failed evidence is retained.
One later ticket-acceptance deadlock prompted bounded idempotent retry handling.

## 44. RabbitMQ and Worker Evidence

Canonical financial queues drained between cycles with publisher/consumer evidence
intact. The low-priority reporting queue can accumulate because this local profile has
no reporting consumer; it is not canonical financial debt but remains an environment
limitation.

## 45. Resource Utilization

Resource snapshots are retained in each campaign's `metrics.jsonl`. No elevated or
burst saturation claim is made. The tested host had under 3 GiB free RAM at campaign
start and substantial concurrent host load.

## 46. Read-Traffic Results

Baseline read p50/p95/p99/max was `5.68/32.76/50.74/88.71 ms`; pilot was
`10.19/39.68/67.31/185.98 ms`. Reads did not prevent canonical write completion.

## 47. Negative-Traffic Results

Cutoff/stale draw, insufficient funds, invalid limits, invalid product operations,
and idempotency conflicts failed closed. No partial ticket or financial effect was
created by the terminal deadlock.

## 48. Failure-Injection Results

Focused restart, retry, and partial-completion QA passed. The complete PR-05C
three-stage failure-injection requirement was not reached because sustained tier
progression stopped before burst qualification.

## 49. Multi-Instance Scheduler Results

Two Game Engine instances coordinated through durable leases without duplicate
outcomes or public draws. A recoverable concurrent scheduler event-hash uniqueness
race was observed once and recovered on retry; it remains a follow-up risk.

## 50. Idempotency and Duplicate Effects

Baseline and retained pilot evidence both reported zero duplicate outcomes, Math
evaluations, aggregates/Settlements, Ledger effects, Wallet effects, and Completion
sources. Conflicting requests fail closed.

## 51. Player and Tenant Isolation

Cross-player contamination was zero. Two tenant/brand scopes were used and no scope
escape was detected.

## 52. Accounting Reconciliation

Baseline due/settled/Wallet stake was exactly 21,909,700 minor units; gross payout
and balanced Ledger debits/credits were 21,942,745. Pilot due/settled/Wallet stake
was exactly 68,864,500; gross payout and balanced Ledger debits/credits were
66,762,025. Future exposure is partitioned separately at the tier cutoff.

## 53. Anomaly Register

Failed and interrupted campaigns remain separate under `.qa/pr-05c/`. Retained
anomalies include fixture player selection, one Wallet deadlock, connection-budget
exhaustion at larger pools, cutoff-boundary evidence correction, result-to-Wallet
tails, one scheduler event-hash race, and the final non-continuous execution gap.

## 54. Capacity Classification

`BASELINE_SUSTAINED_VERIFIED` only. `PILOT_SUSTAINED_VERIFIED` and every burst
classification remain unearned.

## 55. Settlement KPI Disposition

Correctness and exact accounting passed in retained sustained evidence. The 1-2
second target and 5-second super-max p95 objective were not met, so downstream
latency remains a pilot-readiness finding rather than a hidden correctness failure.

## 56. Evidence Inventory and Hashes

Each `.qa/pr-05c/<campaign-id>/` contains environment, workload, tier, metrics,
anomaly, negative-test, failure-injection, summary, report, logs, and hashed evidence
manifest files. Large raw evidence remains local and is not added to Git.

## 57. Qualification Teardown

Verified counts are `0` active pilot products, `0` `PR05_QUALIFICATION_ONLY`
provider activation rows, and `0` active qualification availability rows. Fast Keno
and Hot Spot remain `PUBLISHED / INACTIVE / UNASSIGNED`; production Settlement
activation remains disabled.

## 58. Regression Results

PASS: Game Engine build/tests, Settlement focused tests, lint, fresh migration run,
1,385-check migration validation, aggregate settlement, PR-04A canonical full chain,
Hot Spot multi-draw, durable scheduler, pilot products, canonical tickets,
Settlement/Ledger/Wallet/Completion, integrated runtime, production config,
production Compose, managed-service wiring, production dependency audit, and
`git diff --check`. The host Next.js Turbopack build could not bind its CSS worker
port (`EPERM`), including outside the normal sandbox; this is an environment
restriction and is not represented as a successful build.

## 59. CSPRNG Hash Verification

`services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs`
remains `2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c`.

## 60. Files Created

- `docs/architecture/pr-05c-sustained-burst-capacity-qualification.md`

## 61. Files Modified

- `package.json`
- `scripts/qa/pr05-managed-runtime-qualification.mjs`
- `services/credit-wallet-service/Infrastructure/CanonicalWalletOperationRepository.cs`
- `services/game-engine/src/GameEngine.Api/Configuration/SchedulerOutcomeFanoutConfiguration.cs`
- `services/game-engine/src/GameEngine.Application/Services/SchedulerOutcomeCompletionFanout.cs`

Other stacked uncommitted package files were preserved.

## 62. Migrations Created

None for PR-05C.

## 63. Remaining Limitations

- Pilot sustained qualification must be rerun continuously after the retry repair.
- No burst envelope has been characterized.
- Result-to-Wallet p95 exceeds the objective at both retained sustained tiers.
- The scheduler event-hash uniqueness race should be isolated before claiming
  multi-instance production readiness.
- Capacity must be rerun on an always-on managed qualification host; local host
  execution continuity is not reliable enough for the remaining campaign.

## 64. Recommended Commit Message

`test(runtime): add PR-05C sustained and burst qualification evidence`

## 65. Recommended Next Step

Run the unchanged, retry-aware harness on an always-on managed runner: first repeat
the 500-player 30-minute tier, then proceed to 2,000 players and sequential burst
tiers only after correctness and continuity pass.

## 66. Final Status

`PR_05C_SUSTAINED_BURST_CAPACITY_BLOCKED`
