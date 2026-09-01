# PR-05F Bounded Math Admission and Settlement Queue Throughput

Status: `PR_05F_BOUNDED_QUEUE_THROUGHPUT_PASS`

Campaign: `pr05f-20260829T064000Z-bounded-queue-fast-normalized`

Baseline commit: `8a474adcceda180377f9889ae269835d1b6aac95`

## 1. Executive Summary

PR-05F separates fast, durable Math work admission from bounded Math execution,
and separates RabbitMQ delivery capacity from bounded Settlement database work.
The short diagnostic completed 777 Math evaluations and 269 canonical financial
units with exact accounting, no duplicate effects, no structural deadlocks, and
no live Settlement queue backlog. Result-to-Math p95 improved from 1,768.31 ms
to 955.89 ms; SettlementInput-to-Settlement p95 improved from 4,528.64 ms to
691.34 ms; Result-to-Wallet p95 improved from 17,899.52 ms to 2,628.79 ms.

## 2. Starting Repository State

The worktree began as the accepted, uncommitted PR-04B through PR-05E stack on
`8a474ad`. Historical evidence and the unrelated dirty files
`scripts/operations/local-runtime-inventory.mjs` and
`scripts/qa/local-integrated-runtime.mjs` were preserved. No commit was made.

## 3. Math Admission Design Before

The scheduler enumerated ticket items and drove durable request creation through
the same per-item path that performed evaluation. Repeated connection,
transaction, existence, and idempotency work delayed creation of durable Math
work even though raw deterministic evaluation was approximately 1 ms p95.

## 4. Math Admission Design After

The scheduler now constructs deterministic work identities, admits them through
bounded set operations, and executes admitted work through a separate bounded
path. Admission batch size, admission concurrency, buffered-work ceiling,
evaluation concurrency, and Settlement preparation concurrency are independent.

## 5. Math Batch/Persistence Changes

`ClaimRequestsAsync` performs one bounded PostgreSQL transaction for up to 500
requests, uses conflict-safe insert/readback, and reports immutable-scope
conflicts without rolling back unrelated valid admissions. Exact manifest,
outcome-certificate, Math Model, paytable, ticket, and evaluator lineage remains
bound by the canonical request hash. Migration 146 adds admission evidence;
migration 147 normalizes cross-process clocks without weakening immutability.

## 6. Math Execution Bound

The diagnostic used admission batches of 100, admission concurrency 2, a 5,000
work buffer, and Math execution concurrency 8. Reconstructed high water was 154
waiting and exactly 8 executing, demonstrating durable backpressure rather than
unbounded database execution.

## 7. Settlement Publication Before

Outbox events were published and confirmed individually. The consumer retained
a database transaction and pooled connection while awaiting Settlement, Ledger,
and Wallet HTTP calls. Queue prefetch implicitly determined database pressure.

## 8. Settlement Publication After

The outbox dispatcher publishes bounded persistent batches and waits for one
publisher confirm per batch. Event acknowledgement remains per-event and
idempotent. The Settlement handler commits its claim and releases its connection
before remote authority calls, then reacquires a connection only for final
processing evidence and acknowledgement.

## 9. RabbitMQ Configuration

Settlement uses one durable queue with persistent messages, prefetch 24, and an
explicit execution gate of 24. Outbox publication concurrency is 16. The
publisher channel is shared and channel creation is serialized. The existing
topology, acknowledgements, DLQ, and at-least-once contract are unchanged.

## 10. Settlement Consumer Bound

RabbitMQ availability and Settlement execution are independent. At most 24
handlers may enter the execution gate, while the worker PostgreSQL pool is 14.
Connections are needed only for short claim/finalize scopes, so handlers waiting
on HTTP do not consume database capacity. Observed Settlement execution high
water was 19.

## 11. Fairness/Hot Spot Protection

Queue topology and routing were not changed. The PR-04A full-chain regression
under the new configuration completed Fast Keno and Hot Spot work together.
The dedicated Hot Spot suite passed single draw, Quick Pick, Bullseye, 1/5/10/20
multi-draw, cancellation, retry, restart, and parent completion. The short
campaign was intentionally normalized to Fast Keno because it ran during Hot
Spot's approved 02:00-06:00 America/New_York closed window.

## 12. PostgreSQL Connection Budget

Configured ceilings used by the diagnostic were: two qualification Game Engine
instances at 8 each, harness 4, Settlement worker 14, Settlement Service 8,
Ledger 5, Wallet 6, Auth 1, ordinary workers 2 observed, plus the existing local
Game Engine and evidence collector. Peak was 72/100, leaving 28 connections of
headroom. This is two above the approximate 70 target but materially below the
PR-05E peak of 83.

## 13. Transaction-Scope Changes

Math admission uses one short batch transaction. Provider evaluation remains
outside admission. Settlement claim and finalization are separate short
transactions. No PostgreSQL transaction or connection is held across RabbitMQ
publication, Settlement HTTP, Ledger HTTP, Wallet HTTP, sleeps, or polling.

## 14. Lock-Wait Analysis

Observed lock-waiter peak fell from 18 to 4. Wallet serialization remains the
principal intentional lock. Math admission and Settlement claims no longer
retain locks across downstream work. Migration 144 canonical wallet lock order
is unchanged. Structural deadlocks remained zero.

## 15. Backpressure Design

Math bursts remain durable in `math_evaluation_requests`; execution is limited
by the scheduler gate. Settlement bursts remain durable in the outbox and
RabbitMQ; execution is limited separately from prefetch and by the database
pool. Saturation therefore grows auditable work queues instead of spawning
unbounded database transactions.

## 16. Math Correctness QA

`qa:pr05f-bounded-math-admission` passed for 1, 20, 100, 500, and 2,000 items.
It verified exact counts, deterministic lineage, idempotent duplicates,
conflict isolation, restart/retry behavior, eventual completion, and append-only
admission evidence.

## 17. Settlement Correctness QA

Aggregate Settlement, Settlement focused tests, Ledger durable posting, Wallet
Settlement authority, and Completion suites passed. The diagnostic reconciled
269/269 SettlementInputs, Settlements, and Wallet effects, 149/149 required
Ledger effects, and 777/777 completion sources.

## 18. Hot Spot Regression

`qa:hot-spot-multi-draw-runtime` returned
`PR_04C_HOT_SPOT_MULTI_DRAW_PASS`. All requested draw counts, immutable Quick
Pick/Bullseye bindings, future cancellation, partial completion, retry,
restart, and duplicate fanout checks passed with exact reservation arithmetic.

## 19. Deadlock Regression

`qa:pr05d-wallet-lock-order` passed 96 contenders with zero PostgreSQL
deadlocks, canonical wallet ordering intact, and no financial side effects.

## 20. Short Diagnostic Workload

The diagnostic used 500 configured players, 3 minutes, 3 ticket attempts per
second, two tenants/brands, and a Fast Keno-normalized product mix. It accepted
279 tickets containing 825 items; 777 items became due across seven canonical
draws and produced 269 ticket/draw financial units. No sustained or burst
campaign was run.

## 21. Math Admission p50/p95/p99/max

Result-to-admission-start was 59.79 / 131.14 / 131.98 / 132.16 ms. Admission
duration was 14.54 / 26.76 / 28.24 / 28.64 ms. Per-draw 50%, 95%, and 100%
admission p95 values were 153.90, 160.23, and 160.64 ms respectively.

## 22. Result-to-Math p50/p95/p99/max

381.84 / 955.89 / 1,501.59 / 1,508.74 ms across 269 aggregate-aligned samples.
Raw per-item Math was 17.36 / 70.98 / 98.34 / 180.46 ms across 777 samples.

## 23. Settlement Outbox Publication p50/p95/p99/max

155.54 / 317.56 / 409.30 / 471.03 ms across 269 financial units.

## 24. RabbitMQ Delivery p50/p95/p99/max

Published-to-consumed was 8 / 27 / 54 / 72 ms across 269 financial units.

## 25. SettlementInput-to-Settlement p50/p95/p99/max

405.36 / 691.34 / 879.23 / 1,085.12 ms across 269 financial units.

## 26. Settlement-to-Ledger p50/p95/p99/max

130.29 / 288.38 / 385.50 / 507.32 ms across the 149 payout-bearing units.

## 27. Ledger-to-Wallet p50/p95/p99/max

83.08 / 267.51 / 357.25 / 419.44 ms across 269 financial units.

## 28. Result-to-Wallet p50/p95/p99/max

1,597.14 / 2,628.79 / 3,000.98 / 3,024.42 ms across 269 financial units.

## 29. Result-to-Completion p50/p95/p99/max

1,660.13 / 2,698.83 / 3,028.44 / 3,047.31 ms across 269 completed tickets.

## 30. Queue High-Water Marks

Immutable-timestamp reconstruction produced: Math waiting 154, Math executing
8, Settlement outbox pending 6, Settlement executing 19, and Completion pending
5. The one-second RabbitMQ collector observed 0 ready and 0 unacknowledged at
every sample; the queue was draining faster than its sampling interval.

## 31. Queue Drain Time

All due financial work completed before the three-minute acceptance window
ended, so measured post-load drain time was 0 ms. The final Settlement queue was
0 ready and 0 unacknowledged. Historical DLQ entries from earlier preserved QA
campaigns were not counted as PR-05F live backlog and were not deleted.

## 32. PostgreSQL Peak Connections

72 total connections out of 100, compared with 83 in PR-05E.

## 33. PostgreSQL Active Connections

23 active connections at peak, compared with 33 in PR-05E.

## 34. PostgreSQL Lock Waiters

4 at peak in the independent one-second collector, compared with 18 in PR-05E.

## 35. PostgreSQL Deadlocks

Zero during the diagnostic and zero in the 96-contender regression.

## 36. Comparison vs PR-05E

The workload duration, player count, and 3 tickets/sec density were preserved,
but PR-05F was Fast Keno-normalized because Hot Spot was closed. Result-to-Math
p95 improved 45.9%, SettlementInput-to-Settlement p95 improved 84.7%, and
Result-to-Wallet p95 improved 85.3%. Connections fell 13.3%, active connections
fell 30.3%, and lock waiters fell 77.8%. Raw Math samples include the added
durable orchestration and are not directly comparable to PR-05E's isolated
1.18 ms baseline.

## 37. Correctness/Accounting

Reserved 8,598,600 minor units equalled captured 7,959,600 plus remaining
639,000. Due stake, settled stake, and Wallet stake each equalled 7,959,600.
Gross payout was 7,662,390; Ledger debits and credits each equalled 7,662,390.
Wallet impact was exactly -7,959,600. No cross-player contamination occurred.

## 38. Duplicate-Effect Verification

Duplicate outcomes, Math evaluations, Settlements, completion sources, Ledger
effects, and Wallet effects were all zero. Global final-integrity queries also
reported zero duplicate Settlement, Ledger, and Completion authority effects.

## 39. Regression Results

Passed: Math admission, aggregate Settlement, PR-04A full chain, Hot Spot
multi-draw, durable scheduler 27/27, pilot products 20/20, canonical tickets
57/57, Settlement build/tests, Game Engine build/tests, Completion, Ledger,
Wallet, migration apply/validation, lint, production audit, production config,
production Compose, managed-services wiring, canonical Docker build, and Compose
rendering. Integrated runtime passed after required disposable and host-local
service environment values were supplied. Host `npm run build` was blocked by
the execution sandbox's internal-port restriction; the canonical Docker build
of the same production source passed with Next.js 16.3.1.

## 40. CSPRNG Hash

`2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c`
remained unchanged. No CSPRNG code or qualification evidence changed.

## 41. Files Created

- `docs/architecture/pr-05f-bounded-math-admission-settlement-queue-throughput.md`
- `scripts/migrations/local/146_add_bounded_math_admission_evidence.sql`
- `scripts/migrations/local/147_normalize_cross_clock_math_admission.sql`

## 42. Files Modified

PR-05F contributes changes to:

- `docker-compose.yml`
- `docker-compose.production.yml`
- `package.json`
- `scripts/migrations/migration-manifest.json`
- `scripts/migrations/validate-local-migrations.mjs`
- `scripts/qa/pr05-managed-runtime-qualification.mjs`
- `scripts/workers/dispatch-outbox.ts`
- `services/game-engine/src/GameEngine.Api/Configuration/SchedulerOutcomeFanoutConfiguration.cs`
- `services/game-engine/src/GameEngine.Application/Services/MathEvaluationDurableServices.cs`
- `services/game-engine/src/GameEngine.Application/Services/SchedulerOutcomeCompletionFanout.cs`
- `services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresMathEvaluationPersistence.cs`
- `services/game-engine/tests/GameEngine.Application.Tests/Program.cs`
- `src/domains/workers/canonical-settlement-request-handler.ts`
- `src/domains/workers/outbox-dispatcher.service.ts`
- `src/lib/queue/queue.types.ts`
- `src/lib/queue/rabbitmq/rabbitmq.consumer.ts`
- `src/lib/queue/rabbitmq/rabbitmq.publisher.ts`

These files also contain preserved earlier PR-04B through PR-05E work and remain
uncommitted. The pre-existing unrelated changes in
`scripts/operations/local-runtime-inventory.mjs` and
`scripts/qa/local-integrated-runtime.mjs` were preserved without PR-05F edits.

## 43. Migrations Created

Migration 146 adds immutable Math admission timestamps and lookup evidence.
Migration 147 normalizes admission timestamps against database-created time to
handle cross-process clock skew while retaining the strict ordering constraint.
Both are registered, deterministic, applied, rerunnable, and validated.

## 44. Remaining Bottleneck

The largest remaining downstream components are evaluation-to-aggregate p95
1,049.16 ms, admitted-to-evaluation-start p95 856.32 ms, and Settlement
processing p95 1,085 ms. These are bounded and drain correctly, but explain why
Result-to-Wallet remains above the preferred 1-2 second range.

## 45. Readiness for Sustained/Burst Rerun

Ready. Correctness is exact, Result-to-Wallet is below the 5-second super-max,
Result-to-Math and SettlementInput-to-Settlement meet their one-second p95
targets, queues drained, PostgreSQL retained 28 connections of headroom, Hot
Spot regressions passed, and structural deadlocks remained zero. This short
diagnostic is not itself a sustained-capacity claim.

## 46. Recommended Commit Message

`perf(runtime): bound math admission and settlement queue throughput`

## 47. Recommended Next Step

Run the previously deferred representative mixed-product sustained and burst
qualification during the Hot Spot service window. Preserve these bounds and
compare the new campaign against PR-05E and this short diagnostic before making
a pilot capacity claim.

## 48. Final Status

`PR_05F_BOUNDED_QUEUE_THROUGHPUT_PASS`
