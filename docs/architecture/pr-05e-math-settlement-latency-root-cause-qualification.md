# PR-05E Math and Settlement Queue Latency Root-Cause Qualification

Status: `PR_05E_ROOT_CAUSE_PROVEN_LATENCY_BLOCKED`

Date: 2026-08-29

## 1. Executive Summary

PR-05E proved that raw Math computation is not the material bottleneck. The
pre-remediation Math fanout admitted work through nested, independently
unbounded `Task.WhenAll` calls, so the configured fanout did not cap effective
item concurrency. Result-to-Math p95 was 2,418.78 ms. One shared bounded gate,
combined durable persistence transactions, and removal of redundant request
reads reduced the final all-item p95 to 1,768.31 ms, but did not reach the
one-second target. In the final run, 1,718.51 ms of p95 was already spent before
durable Math work creation; raw Math itself was 1.18 ms p95.

Settlement was initially dominated by a serial outbox publish/confirm/status
loop. Bounded publication concurrency, accurate publish timestamps, and a
narrower claim transaction removed that artificial serialization. Under the
denser final burst, however, the Settlement queue reached 36 ready and 14
unacknowledged messages. Corrected SettlementInput-created-to-Settlement p95
was 4,528.64 ms: 1,602.86 ms in outbox publication and 3,735.20 ms broker wait,
with overlap between these distributions. Raw live authority execution was
662.60 ms p95 and persistence was 153.85 ms p95.

All financial arithmetic reconciled exactly, duplicate effects remained zero,
and structural deadlocks remained zero. The remediation is production-sound,
but bounded latency is not yet proven. Sustained and burst qualification must
not resume until the remaining Math admission and Settlement queue capacity
limits are addressed.

## 2. Starting Repository State

The worktree began with the accepted, uncommitted PR-04B through PR-05D stack.
Historical PR-05D evidence was preserved unchanged. The required 2,000-player,
60-minute observations remain:

- scheduled draw to result p95: 1,600.08 ms
- raw CSPRNG p95: 21.21 ms
- result to Math p95: 24,940.01 ms
- Math to aggregate p95: 250.28 ms
- SettlementInput to Settlement p95: 11,479.07 ms
- Settlement to Ledger p95: 364.50 ms
- Ledger to Wallet p95: 313.98 ms
- result to Wallet p95: 34,616.99 ms
- PostgreSQL peak: 92 total, 52 active, 29 lock waiters, zero deadlocks

No existing PR-05D evidence or unrelated dirty file was rewritten. No commit
was created.

## 3. Diagnostic Workload

The controlled workload used the real Fast Keno and Hot Spot product paths,
internal CSPRNG, canonical ticket acceptance, Math certificates, aggregate and
item Settlement, Ledger, Wallet, and Completion.

| Campaign | Configured | Accepted | Items | Due Math | Financial units |
| --- | ---: | ---: | ---: | ---: | ---: |
| `pr05e-before-20260829` | 500 players / 3 min | 210 | 596 | 419 | 135 |
| `pr05e-after-rerun-20260829` | 500 players / 3 min | 228 | 652 | 486 | 173 |
| `pr05e-final-20260829` | 500 players / 3 min | 228 | 697 | 629 | 279 |

The configured workload was identical. Realized draw and wager density varied,
so both absolute latency and realized unit counts are reported. No 30/60-minute
campaign and no burst ladder was run.

## 4. Math Pipeline Architecture

The canonical scheduler observes the published outcome and invokes the .NET
`DurableMathEvaluationService` in-process. Math does not traverse RabbitMQ.
Each request is canonically hashed, claimed durably, evaluated by the exact
typed evaluator, persisted with its certificate and attempt evidence, and then
used to construct item or ticket/draw aggregate SettlementInput evidence.

The scheduler formerly created one concurrent task set per ticket, each with an
inner `Task.WhenAll`, allowing effective Math concurrency to exceed the
configured limit. It now uses one shared bounded operation gate for all item
Math and post-Math aggregate operations in the page.

## 5. Settlement Pipeline Architecture

Math evidence is converted to immutable SettlementInput evidence. The Outcome
Authority emits one canonical Settlement request and one durable outbox event.
The outbox dispatcher publishes to RabbitMQ, the Settlement worker claims the
request under a deterministic PostgreSQL advisory lock, invokes the canonical
Settlement Service, persists immutable processing evidence, and drives Ledger,
Wallet, and Completion. No authority was bypassed.

## 6. Math Publication Wait

Math has no broker publication stage. Durable evidence records work creation
and publication as the same in-process boundary. Final p50/p95/p99/max for
work-created to published were all 0.00 ms.

## 7. Math Broker Wait

Not applicable. The canonical scheduler invokes durable Math directly in .NET.
Published-to-worker-received is an in-process evidence boundary and was 0.00 ms
at p50/p95/p99/max after clamping sub-millisecond clock-capture ordering noise.

## 8. Math Worker Wait

Final result-to-work-created was 589.73 / 1,718.51 / 1,847.52 / 1,920.12 ms
at p50/p95/p99/max. This is the dominant remaining Math delay. The bounded
global fanout correctly limited effective concurrency to 12, but dense per-draw
bursts queue behind those 12 slots.

Worker-received-to-claim-attempt was 0.09 / 0.25 / 0.49 / 13.32 ms.

## 9. Math Claim and Database Wait

Final pool acquisition wait was 0.10 / 0.25 / 19.98 / 35.19 ms. Claim attempt
to acquired was 25.07 / 67.00 / 97.94 / 123.96 ms. Claim-to-processing was
0.01 / 0.03 / 0.04 / 0.43 ms. PostgreSQL connection acquisition is therefore
not the dominant final Math delay.

The repository now combines Started attempt persistence with request claim, and
combines completion event, certificate, request completion, completed attempt,
and timing evidence in one transaction. A redundant pre-claim read was removed.

## 10. Raw Math Computation

Live final raw Math p50/p95/p99/max was 0.39 / 1.18 / 50.16 / 76.26 ms.
The isolated representative benchmark produced:

| Wagers | p50 ms | p95 ms | p99 ms | max ms |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 0.2479 | 0.4788 | 0.6588 | 1.5564 |
| 5 | 1.4535 | 2.6129 | 3.3176 | 5.7366 |
| 10 | 3.5381 | 6.6570 | 8.1451 | 72.8750 |
| 20 | 2.5856 | 5.7227 | 6.7607 | 8.7698 |

The isolated and live evidence disproves raw Math computation as the primary
bottleneck.

## 11. Math Persistence

Math-complete-to-persistence-complete was 34.04 / 101.55 / 136.02 / 262.06 ms.
Total result-to-Math-complete was 678.26 / 1,768.31 / 1,932.78 / 2,003.70 ms.
Persistence is material but secondary to admission wait.

## 12. Settlement Publication Wait

Final input-created-to-outbox-created p50/p95/p99/max was
43.43 / 211.72 / 299.55 / 404.92 ms. Outbox-created-to-published was
993.62 / 1,602.86 / 1,705.91 / 1,707.60 ms.

The dispatcher now uses bounded concurrency 16 instead of a serial per-event
publish-confirm-status loop. Each event remains individually confirmed and
idempotently marked. `published_at` is captured after the actual publisher
confirmation rather than from the beginning of the polling cycle.

## 13. Settlement Broker Wait

Final published-to-consumed p50/p95/p99/max was
691.50 / 3,735.20 / 4,109.99 / 4,174.00 ms. This became the largest Settlement
delay under the dense final burst.

## 14. Settlement Worker Wait

Consumed-to-claim-acquired was 92.00 / 263.20 / 363.11 / 364.00 ms. The worker
had one consumer with prefetch 14 and bounded effective concurrency 14. It was
not operating one message at a time, but bursts exceeded its end-to-end drain
rate while each message performed authoritative financial orchestration.

## 15. Settlement Claim and Database Wait

Final p50/p95/p99/max:

- pool acquisition: 17.00 / 137.55 / 156.51 / 193.00 ms
- advisory lock: 7.00 / 28.20 / 48.99 / 93.00 ms
- claim query after lock: 57.00 / 194.10 / 340.33 / 345.00 ms
- claim to processing: 0.00 / 0.00 / 0.00 / 0.00 ms

The handler now acquires a session advisory lock, commits the durable claim,
and releases transaction/row-lock scope before remote authority calls. It does
not hold a transaction across Settlement, Ledger, or Wallet network calls.

## 16. Raw Settlement Execution

Live canonical Settlement authority invocation p50/p95/p99/max was
365.50 / 662.60 / 762.10 / 933.00 ms. The isolated in-process Settlement
calculation benchmark over 2,000 iterations was 0.0687 / 0.1461 / 0.2298 /
1.1327 ms. Business calculation is negligible; the live value includes
authoritative service and database orchestration.

## 17. Settlement Persistence

Final explicit processing-evidence persistence p50/p95/p99/max was
47.00 / 153.85 / 404.32 / 417.00 ms. Consumer handler total from delivery to
completion was 1,226.00 / 1,942.00 / 2,115.08 / 2,215.00 ms.

## 18. PostgreSQL Connection Attribution

The final collector observed 83/100 total connections, 33 active, and 18 lock
waiters. Peak connections by application were:

| Application | Total | Active | Lock waiters |
| --- | ---: | ---: | ---: |
| auth-service | 1 | 0 | 0 |
| credit-wallet-service | 6 | 5 | 1 |
| game-engine container | 2 | 2 | 0 |
| ledger-service | 6 | 2 | 1 |
| ordinary `mosera-worker` pool | 15 | 5 | 0 |
| qualification Game Engine 0 | 12 | 12 | 10 |
| qualification Game Engine 1 | 12 | 12 | 12 |
| evidence collector | 2 | 2 | 0 |
| qualification harness | 4 | 4 | 3 |
| settlement-service | 8 | 8 | 1 |
| settlement worker | 14 | 8 | 1 |
| unattributed/admin | 2 | 2 | 0 |

No server connection rejection was observed. Qualification-only duplicate Game
Engine processes account for 24 connections. The normal configured service
budget is approximately 62 connections before operations/admin reserve; the
focused harness and collector increase that budget. Normal runtime must retain
at least 20 connections for administration, recovery, and transients.

## 19. PostgreSQL Lock Attribution

The remaining waiters were predominantly deterministic advisory locks used for
draw/fanout ownership, plus brief transaction, tuple, WAL, and key-share waits.
No structural deadlock or serialization failure occurred. Migration 144's
canonical wallet lock order was not changed.

## 20. RabbitMQ Evidence

Final Settlement queue observations:

- peak ready: 36
- peak unacknowledged: 14
- consumers: 1
- peak publish rate: 21.4 messages/sec
- peak deliver rate: 22.4 messages/sec
- peak acknowledge rate: 20.4 messages/sec
- redelivery/duplicate financial effects: zero

The historical Settlement DLQ depth of 95 was present but no final-campaign
failure or duplicate was attributed to it. Math has no RabbitMQ queue.

## 21. Worker Throughput

Final average realized throughput was approximately 3.48 Math units/sec
(626 completed detailed-evidence units over three minutes) and 1.06 Settlement
units/sec (190 fully correlated timing rows over three minutes). Math effective
concurrency was exactly 12 after remediation. Settlement prefetch and effective
consumer concurrency were 14. Short publish bursts around 21/sec therefore
outpaced full financial handler completion and created queue latency.

## 22. Outbox and Dispatcher Evidence

Before remediation, each outbox event was published, synchronously confirmed,
and marked before the next event. Publication p95 was 1,826.48 ms. Bounded
concurrency 16 removed one-at-a-time dispatch while preserving publisher
confirms and per-event status. The final p95 was 1,602.86 ms, an improvement but
still material. Poll cadence, confirmation round trips, and downstream burst
drain remain limiting factors.

## 23. Host Resource Evidence

The final collector was continuous for 179 of 181 expected workload samples;
maximum heartbeat gap was 1,095.81 ms. Peak host one-minute load was 24.43 on a
16-core Intel host, and minimum reported free memory was 20.8 MB. Peak Docker
CPU percentages were PostgreSQL 802.46%, RabbitMQ 603.39%, Settlement worker
125.89%, Settlement Service 97.37%, and outbox dispatcher 46.02%.

The host was saturated and amplified queue scheduling variability. It is not
the sole root cause: durable stage evidence independently identifies Math
admission and Settlement publication/broker waits, while raw computation stays
small.

## 24. Proven Root Causes

1. Math fanout oversubscription before remediation. Nested ticket-level and
   item-level concurrency bypassed the configured bound.
2. Serial Settlement outbox publish-confirm-status execution before
   remediation.
3. Remaining Math per-draw burst admission. A correct global bound of 12 now
   queues dense draws before durable work creation.
4. Remaining Settlement burst mismatch. Bounded outbox publication can emit
   faster than one 14-prefetch consumer can complete the canonical financial
   chain, producing RabbitMQ ready backlog.
5. Local host CPU/memory pressure amplifies both queues but does not explain raw
   authority cost.

## 25. Remediation Implemented

- one global bounded Math/post-Math operation gate per fanout page
- combined durable Math claim/Started persistence transaction
- combined Math completion/certificate/evidence transaction
- removal of redundant Math request lookup and round trip
- bounded outbox publication concurrency, default 16
- accurate post-confirm publication timestamp
- Settlement session advisory lock with claim committed before network calls
- detailed immutable Math and Settlement stage timing evidence
- application-attributed PostgreSQL waits, RabbitMQ rates, and nonblocking host
  resource collection
- isolated representative Math and Settlement benchmarks
- corrected qualification anchoring from Math certificate `issued_at` to actual
  SettlementInput row `created_at`

No lock, idempotency, authority, evidence, or financial guardrail was removed.

## 26. Connection Budget After

Observed final peak was 83/100 with two qualification Game Engine processes,
the harness, and the collector. This is below the hard ceiling but leaves only
17 connections and is not an acceptable steady-state production target.
Normal configured service pools are approximately 62, leaving about 38 for
operations and transients. Any next remediation must improve queue efficiency
inside that budget rather than raise `max_connections`.

## 27. Lock-Order Verification

`qa:pr05d-wallet-lock-order` passed. Ninety-six concurrent funding and wallet
settlement-style contenders completed with zero deadlocks. Migration 144 remains
authoritative and unchanged.

## 28. Before and After Result-to-Math

| Measurement | Before | After-rerun | Final dense run |
| --- | ---: | ---: | ---: |
| p95 result to Math | 2,418.78 ms | 1,199.97 ms | 1,768.31 ms detailed / 1,826.54 ms financial subset |

The remediation materially improved Math latency, but the final result remains
above the one-second target and varies with per-draw item density.

## 29. Before and After SettlementInput-to-Settlement

The original harness recorded 2,623.39 ms before and 15,960.11 ms in the final
run. The final value was inflated because item SettlementInput timestamps used
the source Math certificate `issued_at`. Recalculation using immutable input
row `created_at`, now fixed in the harness, gives:

| Measurement | Before corrected | Final corrected |
| --- | ---: | ---: |
| p95 input created to Settlement | 2,492.95 ms | 4,528.64 ms |

The final denser workload therefore still regressed and remains above target,
but not by the erroneous 15.96-second amount.

## 30. Before and After Result-to-Wallet

| Measurement | Before | After-rerun | Final dense run |
| --- | ---: | ---: | ---: |
| p95 result to Wallet | 4,755.61 ms | 3,869.13 ms | 17,899.52 ms |
| maximum | 5,448 ms | not used for gate | 19,954.60 ms |

The final run fails both the 1-2 second target and the five-second super-max
objective. Dense burst queueing and later Completion fanout account for the
variation; correctness remains exact.

## 31. Before and After PostgreSQL Connections

Independent collector peaks were 77 before, 81 in the first post-remediation
rerun, and 83 in the final dense run. The pre-remediation root-cause snapshot
also observed 79 at a different sample boundary. Connections did not approach
the prior PR-05D peak of 92, and no rejection occurred.

## 32. Before and After Lock Waiters

Independent collector peak lock waiters were 12 before, 11 in the first
post-remediation rerun, and 18 in the final denser run. The increase is advisory
fanout contention, not a wallet lock cycle. Deadlocks remained zero.

## 33. Before and After Queue Depth

The original five-second snapshots saw zero Settlement ready/unacknowledged,
while durable timestamps showed 699.30 ms p95 broker wait. The improved
one-second collector observed zero ready in the lower-density after-rerun, then
36 ready and 14 unacknowledged in the dense final run. This proves the queue
forms under burst density rather than being inferred from end-to-end latency.

## 34. Correctness and Accounting Result

Final exact reconciliation:

- reserved: 4,565,500 minor units
- captured: 4,523,500
- remaining: 42,000
- due/settled stake: 4,523,300
- gross payout: 3,922,975
- net result: -600,325
- Wallet stake effect: -4,523,300
- Ledger debits: 3,922,975
- Ledger credits: 3,922,975
- complete chain: true

## 35. Duplicate-Effect Result

Duplicate outcomes, Math evaluations, Settlements, Completion sources, Ledger
effects, and Wallet effects were all zero. Cross-player contamination was zero.
No deadlock, serialization failure, transient retry, or retry exhaustion was
recorded in the final campaign.

## 36. Regression Results

Passed:

- Game Engine solution build and test
- Settlement Service and focused test harness build/test
- PR-05B ticket/draw aggregate Settlement QA
- PR-05D 96-contender wallet lock-order QA
- PR-04A scheduler pilot-product financial completion QA
- Hot Spot multi-draw runtime QA
- durable scheduler runtime QA after qualification activation teardown
- pilot product bundle QA
- canonical ticket lifecycle QA
- Settlement financial posting QA
- Ledger durable posting QA
- Credit Wallet Settlement Authority QA
- ticket financial Completion QA
- local integrated runtime QA
- fresh disposable database: 145 migrations applied
- fresh migration validation: 1,399 checks, zero failures
- production config QA
- production Compose QA and `docker compose config --quiet`
- managed-services wiring QA
- lint
- production npm audit: zero vulnerabilities
- `git diff --check`

The final local `npm run build` rerun encountered a Turbopack environment error
while binding an internal local process port (`Operation not permitted`). The
same post-remediation application had already passed the production build and
Docker image build earlier in this package; the late change was confined to a
QA SQL timestamp selector. This is recorded as a local runner limitation, not
silently reported as a fresh pass.

## 37. CSPRNG Hash

`2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c`

The frozen implementation is unchanged. No statistical campaign was rerun.

## 38. Files Created

- `scripts/migrations/local/145_add_pr05e_latency_stage_evidence.sql`
- `docs/architecture/pr-05e-math-settlement-latency-root-cause-qualification.md`
- ignored local evidence under `.qa/pr-05e/` for the before, interrupted,
  after-rerun, and final campaigns

## 39. Files Modified

PR-05E-specific modifications within the stacked worktree:

- `docker-compose.yml`
- `docker-compose.production.yml`
- `scripts/migrations/migration-manifest.json`
- `scripts/migrations/validate-local-migrations.mjs`
- `scripts/qa/pr05-evidence-collector.mjs`
- `scripts/qa/pr05-managed-runtime-qualification.mjs`
- `scripts/workers/dispatch-outbox.ts`
- `services/game-engine/src/GameEngine.Application/Services/MathEvaluationDurableServices.cs`
- `services/game-engine/src/GameEngine.Application/Services/SchedulerOutcomeCompletionFanout.cs`
- `services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresMathEvaluationPersistence.cs`
- `services/game-engine/tests/GameEngine.Application.Tests/Program.cs`
- `services/settlement-service/tests/SettlementService.Tests/Program.cs`
- `src/domains/workers/canonical-settlement-request-handler.ts`
- `src/domains/workers/outbox-dispatcher.service.ts`

All other dirty paths remain part of the pre-existing PR-04B through PR-05D
stack or unrelated local changes and were preserved.

## 40. Migrations Created

Migration 145 adds append-only `game_engine.math_evaluation_processing_evidence`
and detailed connection, advisory-lock, claim, authority, and persistence
timestamps to canonical Settlement processing evidence. It adds chronology
constraints, deterministic indexes, and mutation-blocking triggers. It stores
no entropy, DRBG state, secrets, or mutable financial projection.

## 41. Remaining Bottleneck

Math remains limited by per-draw admission into a shared concurrency gate.
Settlement remains limited by outbox publication latency and a single
Settlement queue consumer's ability to drain a burst while executing the full
authoritative financial chain. PostgreSQL pool wait is measurable but not the
dominant p95. Local host saturation increases variance.

The separate known incomplete Ledger/Wallet/Completion recovery issue after
connection exhaustion remains detectable and is not broadened into this
package.

## 42. Readiness for Sustained and Burst Rerun

Not ready. Correctness, idempotency, deadlock safety, and instrumentation are
ready, but the final dense short diagnostic fails the latency gates and shows a
real Settlement queue backlog. Repeating 30/60-minute or burst campaigns now
would consume time without establishing a new capacity claim.

## 43. Recommended Next Step

Run a narrow follow-up that preserves the current bounds and evidence while:

1. moving Math admission from page-wide task creation to a bounded producer/
   consumer or bounded batch claim so queued work is durable before waiting;
2. measuring and tuning Settlement consumer count/prefetch against the explicit
   PostgreSQL budget, without increasing `max_connections`;
3. reducing remaining outbox poll/confirm overhead through bounded batch
   confirmation only if publisher-confirm semantics remain exact;
4. rerunning the same 500-player diagnostic at fixed realized item and financial
   unit counts before any sustained campaign.

## 44. Final Status

`PR_05E_ROOT_CAUSE_PROVEN_LATENCY_BLOCKED`
