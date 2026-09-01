# PR-05H Aggregate Readiness and PostgreSQL Connection-Budget Remediation

## Status

`PR_05H_AGGREGATE_READINESS_PASS_CAPACITY_BLOCKED`

Campaign evidence: `pr05h-short-20260829`

The aggregate-readiness and PostgreSQL connection-budget objectives passed. The
short 2,000-player-equivalent diagnostic did not satisfy the required
Result-to-Wallet p95 below five seconds, so the 60-minute tier and burst ladder
were not admitted.

## 1. Aggregate-readiness root cause

The runtime does not poll the database to decide whether a ticket/draw group is
ready. The scheduler fanout resolves the required ticket items, executes their
Math evaluations, waits for all evaluations with `Task.WhenAll`, and then creates
the canonical SettlementInput. The original 23.17-second metric therefore was
not a slow readiness query.

The measured latency combined two different financial boundaries. Fast Keno
ticket/draw aggregates were already approximately 2.2-3.1 seconds p95 in the
preserved PR-05G evidence. Hot Spot per-play SettlementInputs dominated the
combined metric: 4,857 preserved samples had p50 11.47 seconds, p95 27.48
seconds, p99 33.90 seconds, and max 38.02 seconds.

The Hot Spot path serialized evaluation-to-input work in three places:

- each evaluated item was converted and emitted sequentially;
- every settlement request for the same outcome version used one draw-wide
  PostgreSQL advisory lock;
- SettlementInput persistence performed a redundant lookup and opened a second
  connection while the first connection remained held.

Aggregate item attribution was also inserted with one database round trip per
item.

## 2. Behavior before remediation

- Readiness polling queries per ticket/draw: 0.
- Readiness scans and joins: 0; readiness was an in-memory `Task.WhenAll`
  boundary over the exact persisted ticket/draw item set.
- Aggregate persistence: one canonical aggregate plus one insert command per
  aggregate item.
- Ordinary SettlementInput persistence: adapter lookup, repository connection,
  nested lookup connection, then insert.
- Settlement request locking: one advisory transaction lock per outcome
  version, serializing unrelated requests from the same draw.
- Qualification connection budget: greater than 100 possible sessions against
  PostgreSQL `max_connections=100`.

## 3. Remediation

- Hot Spot per-play conversion now executes concurrently as one bounded
  `Task.WhenAll` group inside the existing four-ticket fanout boundary.
- Settlement request locking now derives from the exact idempotency key. The
  database uniqueness constraints and canonical payload conflict checks remain
  authoritative.
- Redundant adapter lookups were removed.
- Repository idempotency lookup reuses the already-open connection.
- Aggregate attribution rows use one `NpgsqlBatch` instead of one round trip per
  item.
- No business boundary, cap rule, ticket/draw lineage, canonical hash, replay,
  or recovery behavior changed.

## 4. PostgreSQL connection ownership

Previous defaults included app 6, generic worker pools 2 each, Settlement worker
14 with prefetch/execution 24, Auth 4, Ledger 6, Wallet 6, Settlement 8, Docker
Game Engine 8, two qualification Game Engines up to 16 each, qualification
harness up to 32, and collector 2.

The bounded topology is app 4, generic workers 1 each, Settlement worker 6 with
prefetch/execution 8, Auth 3, Ledger 4, Wallet 4, Settlement 6, Docker Game
Engine 6, qualification Game Engines 6 each, qualification harness 6, and
collector 2. The expected complete qualification topology is approximately
61-63 sessions, leaving administrative and recovery headroom.

The short diagnostic observed a maximum of 51 PostgreSQL sessions. Collected
samples observed at most 10 active sessions and one transient lock waiter; an
independent mid-run snapshot observed 12 active sessions and zero lock waiters.
There were no `too many clients` errors and no structural deadlocks.

## 5. Focused QA

The aggregate service harness passed groups of 1, 20, 100, 500, and 2,000
ticket/draw aggregates. Each group used concurrent duplicate claims and produced
exactly one canonical aggregate and one SettlementInput. Existing coverage also
passed partial-not-ready behavior, conflicting payload rejection, deterministic
replay, restart/retry idempotency, cap semantics, and order independence.

Fast Keno aggregate Settlement passed. Hot Spot multi-draw passed 1/5/10/20
draws, immutable bindings, Quick Pick and Bullseye invariants, partial
completion, future cancellation, restart, duplicate fanout, exact reservations,
and no duplicate settlement effects.

## 6. Short elevated diagnostic

The five-minute 2,000-player-equivalent diagnostic accepted 574 tickets and
completed all 532 expected financial units. It produced 1,158 Math certificates,
532 SettlementInputs, 532 settlements, 532 wallet effects, and all expected
completion sources.

There were zero duplicate outcomes, evaluations, settlements, ledger effects,
wallet effects, or completion sources; zero cross-player contamination; zero
deadlocks; and exact financial reconciliation.

The immutable `campaign-pilot.json` was written successfully with `pass: true`.
The harness process subsequently exited while writing its top-level anomaly
register because the same campaign identity had first been used by the failed
preflight attempt. That `EEXIST` evidence-file collision did not alter the tier
result or runtime evidence, but the campaign is used only as a diagnostic and
not as a sustained qualification claim.

## 7. Evaluation-to-Aggregate before and after

- Before: p95 23,169.94 ms from the combined PR-05G metric.
- After: p50 508.18 ms, p95 2,528.36 ms, p99 2,800.34 ms, max 2,958.36 ms.
- Reduction: 89.1 percent at p95.

## 8. Result-to-Wallet before and after

- Before: p95 31,149.29 ms.
- After: p50 10,256.93 ms, p95 65,815.25 ms, p99 68,083.50 ms, max 68,633.65 ms.

The aggregate improvement exposed a downstream bottleneck. Settlement publish
wait was p95 60,249.95 ms and Settlement queue wait was p95 19,215 ms. Settlement
processing itself was p95 2,073 ms; Ledger-to-Wallet was p95 296.99 ms.

## 9. PostgreSQL sessions and locks before and after

- Before: 101/100 sessions, 44 active, 24 lock waiters, and eight connection
  exhaustion failures.
- After: maximum 51 sessions, maximum observed active 12, maximum transient lock
  waiters 1, zero structural deadlocks, and zero connection exhaustion.

## 10. 2,000-player 60-minute result

Not admitted. The short diagnostic failed the mandatory Result-to-Wallet p95
below five seconds.

## 11. Burst results

Not admitted. The burst ladder depends on a passing 60-minute elevated tier.

## 12. Highest verified tickets per draw

No new sustained capacity claim was established by PR-05H. Focused aggregate
correctness is verified through 2,000 ticket/draw groups, but that is not a
sustained tickets-per-draw capacity qualification.

## 13. Accounting, duplicates, and isolation

PASS. The campaign reconciled 11,208,100 minor units of due and settled stake,
10,025,270 minor units of gross payout, and balanced Ledger debit/credit totals
of 10,025,270. Duplicate and cross-player counters were zero.

## 14. Recovery

The short campaign drained all expected current financial work and reported no
draw recovery backlog. PR-05F bounded admission and PR-05D wallet lock ordering
passed. The standalone PR-05G focused recovery rerun could not create its test
scenario because the reused database contained no untouched two-item canonical
`SETTLEMENT_REQUESTED` tickets; it failed before mutation with `available: 0`.

## 15. Remaining bottleneck

The measured blocker is now downstream publication and queue throughput:

- Settlement outbox publish wait p95: 60.25 seconds.
- Settlement RabbitMQ queue wait p95: 19.22 seconds.
- Maximum ready Settlement queue backlog: 191.
- Maximum unacknowledged Settlement messages: 8.

This package intentionally stops rather than changing the frozen Settlement or
outbox architecture without a dedicated measured remediation package.

## 16. Regression and CSPRNG

PASS:

- PR-05H aggregate readiness harness
- PR-05F bounded Math admission
- PR-05D wallet lock ordering, including 96 concurrent contenders
- aggregate Settlement and focused Settlement tests
- Hot Spot multi-draw runtime
- Game Engine solution build and tests
- TypeScript lint
- local migration run: 147 skipped as already applied, 0 failures
- migration validation through runtime inventory
- local and production Compose configuration
- `git diff --check`

The CSPRNG source hash remains
`2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c`.

The Next.js production build remains unverified in this runner because
Turbopack cannot bind its internal helper port (`Operation not permitted`). The
integrated runtime passed inventory, migrations, service readiness, Auth cutover,
and the Settlement persistence/execution/recovery suites, then stopped at the
pre-existing host-side Settlement authority endpoint reachability issue.

## 17. Files and migrations changed

PR-05H files:

- `docker-compose.yml`
- `docker-compose.production.yml`
- `package.json`
- `scripts/qa/pr05-managed-runtime-qualification.mjs`
- `services/game-engine/src/GameEngine.Application/Services/SchedulerOutcomeCompletionFanout.cs`
- `services/game-engine/src/GameEngine.Application/Services/SettlementInputAdapterServices.cs`
- `services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresCanonicalOutcomePipelineRepository.cs`
- `services/game-engine/src/GameEngine.Infrastructure/Persistence/PostgresSettlementInputPersistence.cs`
- `services/game-engine/tests/GameEngine.Application.Tests/Program.cs`
- `docs/architecture/pr-05h-aggregate-readiness-connection-budget-remediation.md`

No migration was added or modified by PR-05H. Existing uncommitted PR-04B through
PR-05G work remains preserved.

## 18. Recommended next step

Create a narrow follow-up that measures and remediates canonical Settlement
outbox publication and Settlement consumer queue throughput. Preserve the new
connection budgets and do not rerun the sustained tier until a short diagnostic
proves Result-to-Wallet p95 below five seconds.

## 19. Final status

`PR_05H_AGGREGATE_READINESS_PASS_CAPACITY_BLOCKED`
