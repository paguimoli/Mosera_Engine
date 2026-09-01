# PR-05D Deadlock Closure and Managed Requalification

Status: `PR_05D_MANAGED_SUSTAINED_BURST_QUALIFICATION_BLOCKED`

Date: 2026-08-28

## 1. Executive Summary

PR-05D closed the preserved PostgreSQL deadlock as a structural lock-order defect. Migration 144 makes Funding Instrument Authority acquire the existing canonical wallet advisory lock before it inserts wallet-referencing evidence, aligning ticket acceptance with Wallet settlement. Focused 96-contender QA and both sustained campaigns recorded zero deadlocks, retries, duplicate effects, or cross-player contamination.

The 500-player/30-minute and 2,000-player/60-minute mixed-product campaigns completed with continuous independent evidence and exact accounting. They qualify correctness on this local Docker environment, but not the 1-2 second result-to-Wallet objective. The burst ladder did not qualify capacity: neither the 500 nor 1,000 requested target was fully accepted before cutoff, and the 2,500 target caused PostgreSQL connection exhaustion and incomplete downstream recovery. No 5,000 or 10,000 burst was attempted after that correctness failure.

## 2. Starting Repository State

The worktree was already a large uncommitted stack containing PR-04B, PR-04C, PR-05, PR-05A, PR-05B, and PR-05C work. The accepted 100-player baseline, the original failed 500-player deadlock evidence, the retry-aware execution with a telemetry gap, and all prior anomaly evidence were preserved. The unrelated dirty files `scripts/operations/local-runtime-inventory.mjs` and `scripts/qa/local-integrated-runtime.mjs` were not reverted or staged.

No commit was created.

## 3. Deadlock Forensics

Preserved PostgreSQL log time: `2026-08-28 05:19:37.287 UTC`.

- PID 22219 executed `ticket_authority.accept_ticket(...)`.
- PID 20801 executed `credit_wallet_service.apply_authoritative_wallet_settlement(...)`.
- PID 22219 waited for `ShareLock` on transaction 2055312, held by PID 20801.
- PID 20801 waited for `ShareLock` on transaction 2055217, held by PID 22219.
- The victim row was tuple `(155,9)` in `public.financial_wallets`.
- Ticket acceptance reached `funding_authority.resolve_funding_instrument`, inserted immutable funding evidence with a wallet foreign key, then reached `assert_wallet_scope -> reserve_wallet -> persist_authorized_ticket -> accept_ticket` and attempted the wallet row update lock.
- Wallet settlement inserted request evidence with the wallet foreign key and then reached the canonical wallet service row lock.
- The canonical Wallet path already acquired `pg_advisory_xact_lock(hashtextextended('canonical-wallet:' || wallet_id, 0))`; Funding Authority did not.

Deadlock graph:

```text
Ticket acceptance
  funding evidence FK/key-share
  -> canonical wallet advisory lock (missing before migration 144)
  -> financial_wallets row update

Wallet settlement
  canonical wallet advisory lock
  -> settlement evidence FK/key-share
  -> financial_wallets row update
```

The two paths therefore acquired wallet-related resources in inconsistent order.

## 4. Deadlock Classification

Classification: **A, structural lock-order defect**.

This was not dismissed as harmless transient contention. It was a real cycle between canonical ticket acceptance and canonical Wallet settlement. The preserved failure evidence remains unchanged.

## 5. Deadlock Remediation/Retry Policy

Migration 144 patches `funding_authority.resolve_funding_instrument` to acquire the same deterministic `canonical-wallet:<wallet-id>` transaction advisory lock used by Wallet settlement before funding idempotency/evidence work. This is narrow per-wallet serialization, not broad platform serialization.

Existing bounded transient retry remains defense in depth. It retains the canonical idempotency identity, recognizes transient database failures only, exposes deadlock/retry/success/exhaustion counters and added latency, and cannot regenerate Settlement, Ledger, Wallet, or Completion identities.

## 6. Focused Deadlock QA

`qa:pr05d-wallet-lock-order` passed on the canonical local fixture:

- 96 concurrent contenders.
- deterministic per-wallet ordering;
- zero deadlocks;
- zero correctness failures;
- no Ledger, Wallet, Settlement, or Completion side effects;
- update order statically verified in the patched SQL function.

The first fresh-database invocation correctly failed before contention because a fresh database has no active governed wallet fixture. The canonical fixture run and sustained campaigns provide the applicable contention evidence.

## 7. Qualification Environment

Managed credentials or approved managed services were not available. Qualification used the isolated, non-production Docker topology with PostgreSQL, RabbitMQ, Redis, Game Engine, Settlement, Ledger, Credit Wallet, workers, and required runtime components.

All capacity conclusions apply only to this local Docker environment. No production deployment or managed-capacity claim is made.

## 8. Managed/Always-On Runner Status

Managed runner: unavailable because no credentials were present.

Local fallback: implemented with an independent evidence collector process, append-only JSONL heartbeats, an execution identity, explicit campaign control state, and automatic continuity validation. The collector is independent of the workload driver and does not silently stitch restarts.

## 9. Evidence Continuity Design

Collector execution ID: `39b8af8a-04b7-4f0a-b646-a7876d45ae35`.

- heartbeat interval: 5 seconds;
- 500-player run: first `20:54:52.308Z`, last `21:24:57.470Z`, max gap 5,280.386 ms, 360/361 boundary samples, continuous;
- 2,000-player run: first `21:26:47.562Z`, last `22:26:53.367Z`, max gap 5,117.983 ms, 720/721 boundary samples, continuous;
- workload and failure-injection executions are separately identified;
- partial/harness-failure evidence is retained rather than rewritten.

## 10. Fresh Database Result

`lottery_disposable` was recreated and all 144 disposable migrations applied from zero. Migration validation passed 1,387 checks with zero failures. A second fresh `lottery_test` database was later created for isolated Hot Spot full-chain verification; all 144 migrations applied from zero there as well.

## 11. Campaign Identity

Sustained campaign: `pr05d-20260828T205300Z-deadlock-closure`.

Final burst campaign: `pr05d-20260828T231000Z-burst-resume3`.

Preserved harness investigations:

- `pr05d-20260828T224900Z-burst-resume1`;
- `pr05d-20260828T230000Z-burst-resume2`.

Failure injection: `pr05d-recovery-3c08a8d5-f0a4-4080-9ec8-4530e3cbc524`.

## 12. 500-Player 30-Minute Result

PASS for duration, continuity, correctness, exact accounting, cadence, and eventual completion on the local Docker topology. The downstream latency objective did not pass.

Started `2026-08-28T20:54:54.821Z`; ended `2026-08-28T21:24:54.958Z`.

## 13. 500-Player Ticket/Item Counts

- 3,437 attempts;
- 2,836 accepted tickets;
- 7,758 ticket items;
- 7,615 due Math certificates;
- 3,637 aggregate SettlementInputs, Settlements, and Wallet effects;
- 1,416 expected and actual Ledger effects;
- 2,789 expected and actual parent completions;
- 1,992 Fast Keno tickets and 844 Hot Spot tickets.

Attempt error categories overlap with attempt telemetry and therefore must not be arithmetically added to accepted counts.

## 14. 500-Player Draw Counts

- 71 Fast Keno draws;
- 8 Hot Spot draws;
- 79 authoritative outcomes in the campaign window;
- zero missed draws;
- zero measured schedule drift.

## 15. 500-Player Latency Distribution

- scheduled draw to result: p50 362.05 ms, p95 897.95 ms, p99/max 1,437.97 ms;
- result to Math evaluation: p50 719.88 ms, p95 13,843.45 ms, p99 17,477.92 ms, max 19,569.13 ms;
- evaluation to aggregate: p50 16.39 ms, p95 131.82 ms, p99 235.35 ms, max 476.72 ms;
- SettlementInput to Settlement: p50 1,484.95 ms, p95 5,857.75 ms, p99 8,366.70 ms, max 13,143.86 ms;
- Settlement to Ledger: p50 166.62 ms, p95 309.93 ms, p99 465.27 ms, max 716.76 ms;
- Ledger to Wallet: p50 0 ms, p95 264.64 ms, p99 392.10 ms, max 985.31 ms;
- result to Wallet: p50 2,700.39 ms, p95 17,613.54 ms, p99 20,972.04 ms, max 23,463.20 ms.

## 16. 500-Player Deadlock/Retry Statistics

Deadlocks 0; transient retries 0; retry successes 0; retry exhaustions 0; added retry latency 0 ms.

## 17. 500-Player Backlog

Fast Keno ended with zero unsettled accepted tickets and no due/recovery draw debt. Hot Spot retained 23 unsettled tickets and 143 future items representing valid multi-draw future exposure, not overdue financial debt. Classification: Fast Keno `CLEARING`; Hot Spot future exposure `STABLE`.

## 18. 500-Player Accounting

- reserved: 61,078,100 minor units;
- captured: 61,031,000;
- remaining future exposure: 47,100;
- due and settled stake: 60,249,100;
- gross payout: 58,646,750;
- net result: -1,602,350;
- Wallet stake effect: 60,249,100;
- Ledger debits = credits = 58,646,750.

Accounting reconciled exactly.

## 19. 2,000-Player 60-Minute Result

PASS for duration, continuity, correctness, exact accounting, cadence, and eventual completion on the local Docker topology. The downstream latency objective did not pass.

Started `2026-08-28T21:26:50.003Z`; ended `2026-08-28T22:26:50.041Z`.

## 20. 2,000-Player Ticket/Item Counts

- 10,195 attempts;
- 8,413 accepted tickets;
- 22,632 items;
- 22,351 due Math certificates;
- 10,709 aggregate SettlementInputs, Settlements, and Wallet effects;
- 3,964 expected and actual Ledger effects;
- 8,282 expected and actual parent completions;
- 5,947 Fast Keno tickets and 2,466 Hot Spot tickets.

## 21. 2,000-Player Draw Counts

- 143 Fast Keno draws, approximately the expected 144 cycles;
- 15 Hot Spot draws;
- 158 authoritative outcomes in the campaign window;
- zero missed draws;
- zero measured schedule drift.

## 22. 2,000-Player Latency Distribution

- scheduled draw to result: p50 413.27 ms, p95 1,600.08 ms, p99 2,010.19 ms, max 2,196.72 ms;
- raw provider execution: p50 3.88 ms, p95 21.21 ms, p99 39.32 ms, max 65.89 ms;
- result to Math evaluation: p50 1,656.33 ms, p95 24,940.01 ms, p99 30,216.03 ms, max 35,246.64 ms;
- evaluation to aggregate: p50 23.27 ms, p95 250.28 ms, p99 412.39 ms, max 757.11 ms;
- SettlementInput to Settlement: p50 2,839.27 ms, p95 11,479.07 ms, p99 15,890.03 ms, max 24,004.71 ms;
- Settlement to Ledger: p50 199.76 ms, p95 364.50 ms, p99 467.45 ms, max 1,097.67 ms;
- Ledger to Wallet: p50 0 ms, p95 313.98 ms, p99 445.60 ms, max 1,008.41 ms;
- result to Wallet: p50 5,038.77 ms, p95 34,616.99 ms, p99 39,988.14 ms, max 44,658.97 ms.

## 23. 2,000-Player Deadlock/Retry Statistics

Deadlocks 0; transient retries 0; retry successes 0; retry exhaustions 0; added retry latency 0 ms.

## 24. 2,000-Player Backlog

Fast Keno ended with zero unsettled tickets and no due/recovery draw debt. Hot Spot had one unsettled ticket at the sample boundary and 281 valid future items. Classification: Fast Keno `CLEARING`; Hot Spot future exposure `STABLE`.

## 25. 2,000-Player Accounting

- reserved: 180,894,900 minor units;
- captured: 180,894,600;
- remaining future exposure: 300;
- due and settled stake: 179,745,000;
- gross payout: 166,894,290;
- net result: -12,850,710;
- Wallet stake effect: 179,745,000;
- Ledger debits = credits = 166,894,290.

Accounting reconciled exactly.

## 26. Scheduled Draw to Result Timing

The 500-player p95 of 897.95 ms met the p95 <1 second target. The 2,000-player p95 of 1,600.08 ms did not. Due detection, claim, provider execution, outcome persistence, and certificate issuance remain separately recorded in the campaign JSON.

## 27. Raw CSPRNG Timing

- 500-player: p50 4.28 ms, p95 7.64 ms, p99/max 40.11 ms;
- 2,000-player: p50 3.88 ms, p95 21.21 ms, p99 39.32 ms, max 65.89 ms.

The CSPRNG was not the dominant downstream latency source.

## 28. Result to Wallet Timing

The primary 1-2 second and super-max 5-second objectives were not met. The dominant tails accumulated in result-to-evaluation publication and SettlementInput-to-Settlement processing. No tails were hidden or excluded.

## 29. PostgreSQL Connection/Lock Evidence

Independent sustained metrics recorded:

- 500-player peak connections 90, peak active 40, peak lock waiters 26;
- 2,000-player peak connections 92, peak active 52, peak lock waiters 29;
- PostgreSQL `max_connections` was 100;
- database deadlocks remained 0 after migration 144.

During the 2,500-target burst, PostgreSQL emitted repeated `FATAL: sorry, too many clients already`; this was the exact burst blocker.

## 30. RabbitMQ/Worker Evidence

Peak aggregate RabbitMQ messages were 41 at 500 players and 182 at 2,000 players; both sustained runs drained accepted work without DLQ effects. The 2,500-target burst produced two settlement DLQ messages during connection exhaustion. Governed replay operation `44302c1f-0b88-4f89-b401-d9491bddddf2` replayed both with preserved hashes and drained the DLQ, but did not automatically complete all interrupted financial units.

## 31. Resource Evidence

Local Docker resource samples recorded high host pressure:

- 500-player max one-container CPU 1,002.18%, max one-container memory 13.34%, minimum host free memory 56,205,312 bytes;
- 2,000-player max one-container CPU 1,311.28%, max one-container memory 18.61%, minimum host free memory 36,487,168 bytes;
- 2,000-player maximum 1-minute host load average 22.82.

These are local Docker host observations, not managed capacity measurements.

## 32. Hot Spot Concurrent Result

Hot Spot remained active in both sustained tiers with Quick Pick, Bullseye, and multi-draw coverage. It was not starved to improve Fast Keno results. The isolated full-chain run `818a54b4-aaf0-42d7-9149-89a31a0569ce` passed 1/5/10/20 draw binding, immutable sequences, exact upfront reservation, partial parent completion, future-only cancellation, restart/concurrent fanout, 42 unique active participations, zero duplicate evaluations/settlements, exact reservation accounting, invariant Quick Pick/Bullseye/stake data, and qualification teardown.

## 33. Burst 500 Result

Target 500; 189 accepted before cutoff; 739 target items; 743 chain evaluations; 193 aggregates including Hot Spot coverage. Submission window 24.442 seconds. All accepted work completed correctly with zero duplicates and exact accounting, but the requested 500-ticket target was not achieved.

Result to Wallet: p50 14.529 seconds, p95 23.743 seconds, p99 24.539 seconds, max 24.588 seconds. Completion milestones: 50% 15.713 seconds, 95% 24.396 seconds, 99/100% 28.144 seconds. Classification: `BURST_CORRECT_BUT_BACKLOG_CAPACITY_REACHED`.

## 34. Burst 1,000 Result

Target 1,000; 179 accepted; 1,081 items/evaluations; 179 aggregates. Submission window 32.700 seconds. Accepted work completed correctly and exactly, but the target was not achieved.

Result to Wallet: p50 17.432 seconds, p95 26.895 seconds, p99 27.752 seconds, max 27.768 seconds. Completion milestones: 50% 12.117 seconds and 95/99/100% 20.256 seconds. Classification: `BURST_CORRECT_BUT_BACKLOG_CAPACITY_REACHED`.

## 35. Burst 2,500 Result

Target 2,500; 154 target tickets accepted; 923 target items; 936 chain evaluations; 167 aggregates. Submission window 53.583 seconds. Errors included 925 cutoff/stale and 1,421 transient/unknown failures. PostgreSQL exhausted its 100-connection budget.

After the 15-minute drain, only 72 of 154 target completions were observed. Chain evidence contained 167 Settlements but only 85 Wallet effects, 69 Ledger effects, 70 parent completions, and 74 closed reservations. No duplicate outcome, evaluation, settlement, ledger, wallet, completion, or cross-player effect occurred, but incomplete financial recovery is a correctness failure. Classification: `BURST_CORRECTNESS_FAILED`.

## 36. Burst 5,000 Result

Not started. The 2,500-target correctness failure required fail-closed termination of higher tiers.

## 37. Burst 10,000 Stress Result

Not started. No 10,000-ticket stress claim exists.

## 38. Highest Verified Tickets/Draw

No requested burst tier is verified. The final corrected 500-target run accepted 189 tickets and completed them correctly; an earlier harness investigation accepted 227/500 but used a four-driver bottleneck and is retained as diagnostic evidence only. Therefore the answer to the capacity question is: **no production-representative Fast Keno tickets-per-draw burst capacity has yet been established**.

## 39. Evaluations/Draw at Verified Capacity

No requested burst capacity was verified. The highest final corrected, fully drained diagnostic burst produced 743 chain evaluations for 193 aggregate financial units, but it cannot be promoted to a capacity claim.

## 40. Aggregate Settlements/Draw at Verified Capacity

No requested burst capacity was verified. The final corrected 500-target diagnostic completed 193 aggregate financial units exactly.

## 41. Next-Draw Pending-Fund Evidence

The 500-target diagnostic reached 100% completion after 28.144 seconds, already beyond a 25-second Fast Keno interval. The 1,000-target diagnostic reached 100% at 20.256 seconds for accepted work, but accepted only 179/1,000. The 2,500-target run retained 86 unsettled Fast Keno tickets after 15 minutes. No tested requested burst proves backlog-free operation across subsequent 25-second draws.

## 42. Failure-Injection Result

Separate execution `pr05d-recovery-3c08a8d5-f0a4-4080-9ec8-4530e3cbc524` restarted one Game Engine instance, the settlement worker, and RabbitMQ. All services recovered without duplicate/lost financial effects. Failure injection was kept outside sustained evidence.

## 43. Duplicate-Effect Verification

Both sustained tiers and the completed 500/1,000 burst diagnostics recorded zero duplicate outcomes, Math evaluations, Settlements, Completion sources, Ledger effects, and Wallet effects. The failed 2,500 run also recorded zero duplicates among completed evidence.

## 44. Player/Tenant Isolation

Cross-player contamination was 0 in every sustained and burst campaign. Qualification used one isolated synthetic hierarchy and did not activate any production tenant, player, brand, or site.

## 45. Final Accounting Reconciliation

Both sustained tiers and the completed 500/1,000 diagnostic bursts reconciled exactly. The 2,500-target run preserved balanced Ledger entries for its completed subset, but did not fully reconcile end to end because interrupted Wallet/Ledger/Completion units remained incomplete. That mismatch is treated as a blocker, not normalized away.

## 46. Capacity Classification

- 500 active players for 30 minutes: local correctness qualified, latency objective failed;
- 2,000 active players for 60 minutes: local correctness qualified, latency objective failed;
- 500-ticket burst: target not reached;
- 1,000-ticket burst: target not reached;
- 2,500-ticket burst: correctness and recovery failed under connection exhaustion;
- managed/production capacity: not qualified.

## 47. Evidence Inventory/Hashes

Primary evidence is under `.qa/pr-05d/` and remains local/untracked. The final burst evidence manifest records SHA-256 hashes for 15 artifacts, including:

- `campaign-burst-500.json`: `0132f3c6be577d9e6e02809cd97cf214937f0c7d7cb2776dd86d0e28b5321d5a`;
- `campaign-burst-1000.json`: `072786d8d91a9b834509b9abdf2f78b0ad4bebeb642163741d283366465084f9`;
- `campaign-burst-2500.json`: `432d27edb7072b562c1e707e23d93ac7f9bdebe29b3369936d9b54262856336c`;
- `independent-metrics.jsonl`: `82aae91697d82314d42c0077a5ed9f43fcdd11a6bef584b6af3dad0bbd4b86d3`;
- `qualification-summary.json`: `063526ddff54757bd9c5862f6707ed5e2d6d296f6116c98019daf19c65342cb8`.

The sustained campaign retains `campaign-pilot.json`, `campaign-elevated.json`, independent metrics, logs, anomaly register, failure-injection identity, and workload metadata. Earlier PR-05C evidence was not deleted or rewritten.

## 48. Qualification Teardown

After qualification:

- active qualification availability rows: 0;
- active canonical provider events: 0;
- production Settlement activation: disabled;
- pilot products: `PUBLISHED / INACTIVE / UNASSIGNED`;
- disposable services were restored to `lottery_local`;
- no production authority was activated.

## 49. Regression Results

PASS:

- Game Engine build and tests;
- Settlement build and focused tests;
- PR-05B ticket/draw aggregate settlement;
- PR-04A full chain;
- Hot Spot multi-draw isolated full chain;
- durable scheduler;
- pilot product bundle;
- canonical ticket lifecycle;
- Settlement, Ledger, Wallet, and Completion authority QA;
- local migrations and fresh-database application;
- migration validation: 1,387 checks, 0 failures;
- lint;
- production npm audit: 0 vulnerabilities;
- production configuration, Compose QA, and managed-services wiring;
- local integrated runtime with explicit disposable migration approval and host service URLs;
- `docker compose config`;
- `git diff --check`.

Host `npm run build` encountered the known Turbopack sandbox port-binding restriction. Production Compose references pinned/prebuilt images and reported no local buildable services; it did not provide a new image build result. This is retained as a limitation, not presented as a green source build.

## 50. CSPRNG Hash

`services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs` remains:

`2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c`

## 51. Files Created

- `docs/architecture/pr-05d-deadlock-managed-requalification.md`
- `scripts/migrations/local/144_align_funding_wallet_lock_order.sql`
- `scripts/qa/pr05-evidence-collector.mjs`
- `scripts/qa/pr05d-wallet-lock-order.mjs`

Qualification evidence was also created under `.qa/pr-05d/` and remains untracked/local.

## 52. Files Modified

PR-05D-specific modifications:

- `package.json`
- `scripts/migrations/migration-manifest.json`
- `scripts/migrations/validate-local-migrations.mjs`
- `scripts/qa/pr05-managed-runtime-qualification.mjs`

The broader stacked worktree contains numerous pre-existing PR-04/PR-05 and unrelated modifications; they were preserved.

## 53. Migrations Created

Migration 144: `144_align_funding_wallet_lock_order.sql`.

It changes only Funding Authority wallet lock ordering and does not broaden financial authority or change business economics.

## 54. Remaining Limitations

- No managed qualification environment was available.
- Sustained downstream latency misses the 1-2 second and 5-second objectives.
- PostgreSQL's local 100-connection budget is exhausted by the 2,500-target burst.
- Recovery does not automatically finish all interrupted financial units after connection exhaustion and DLQ replay.
- No requested Fast Keno burst tier is capacity-qualified.
- Production Compose uses pinned images and does not locally rebuild source services.
- Qualification evidence remains local/untracked and is not immutable WORM evidence.

## 55. Recommended Commit Message

`fix(runtime): align wallet locks and add PR-05D qualification evidence`

Do not commit until the stacked PR-04/PR-05 file ownership is reviewed.

## 56. Recommended Next Step

Create a narrow connection-budget and recovery package before rerunning burst qualification:

1. set and verify an explicit cross-service PostgreSQL connection budget below `max_connections` with reserved administrative/recovery capacity;
2. bound burst-driver concurrency independently from service pools;
3. add automatic recovery/reconciliation for incomplete Ledger/Wallet/Completion units after database connection exhaustion;
4. rerun from the 500-ticket burst on a managed or production-like environment without rerunning the qualified 100/500/2,000 sustained campaigns unless runtime behavior changes.

## 57. Final Status

`PR_05D_MANAGED_SUSTAINED_BURST_QUALIFICATION_BLOCKED`

Highest verified sustained tier: 2,000 active players for 60 continuous minutes with exact correctness on local Docker.

Highest verified requested burst tier: none.

Exact blocker: PostgreSQL connection-budget exhaustion at the 2,500-target burst, followed by incomplete automatic recovery of canonical Ledger/Wallet/Completion units. The original deadlock itself is closed.
