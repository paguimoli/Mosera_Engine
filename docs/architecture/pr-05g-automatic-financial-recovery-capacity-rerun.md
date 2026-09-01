# PR-05G Automatic Financial Recovery and Capacity Rerun

## Status

- Recovery: `PR_05G_AUTOMATIC_FINANCIAL_RECOVERY_PASS`
- Capacity: `PILOT_SUSTAINED_VERIFIED`
- Overall: `PR_05G_RECOVERY_PASS_CAPACITY_BLOCKED`
- Qualification campaign: `pr05g-20260830T000800Z-auto-recovery`
- Highest verified tier: 500-player, 30-minute sustained pilot
- Elevated tier: correctness passed, latency/capacity gates failed
- Burst ladder: not admitted after the elevated tier reached the characterized capacity ceiling

PR-05G does not make a 2,000-player or burst-capacity production claim.

## Recovery Design

The Settlement Service now owns one bounded automatic recovery loop. It queries durable Settlement and financial-instruction evidence, determines the last completed authoritative stage, and invokes only the missing Ledger, Wallet, or Completion stage through existing canonical services and idempotency identities.

The worker uses a PostgreSQL advisory lease for horizontal leader election, bounded batch size and concurrency, an age grace period, bounded retries with backoff, and cancellation-aware execution. Completed Math, Settlement, Ledger, Wallet, and Completion evidence is never regenerated. Contradictory or terminal non-transient evidence is recorded fail closed and excluded from repeated selection. Recovery configuration and health are exposed through the existing Settlement readiness surface.

## Focused Recovery Qualification

The focused QA injected incomplete chains after Settlement, after Ledger, and after Wallet, then restarted the settlement worker, RabbitMQ, the Settlement Service, and PostgreSQL. The two canonical two-line tickets converged automatically:

- financial instructions: 8
- terminal attempts: 8
- ticket completions: 2
- unresolved fixture instructions: 0
- duplicate terminal attempts: 0
- duplicate Ledger effects: 0
- duplicate Wallet effects: 0
- reservation reconciliations: 2 of 2
- Hot Spot future multi-draw evidence: unchanged
- terminal fail-closed evidence count: stable across subsequent cycles

The disposable database contains historical incomplete QA evidence from earlier packages. PR-05G proves its own fixture backlog returns to zero and does not increase that historical backlog; it does not delete append-only historical evidence.

## 500-Player Sustained Tier

The 500-player tier ran for the full 30 minutes and passed the sustained correctness gate.

| Measure | Result |
| --- | ---: |
| Attempted / accepted tickets | 3,212 / 2,631 |
| Ticket items | 6,715 |
| Authoritative outcomes | 77 |
| Due evaluations / Math certificates | 6,509 / 6,509 |
| Aggregate SettlementInputs / Settlements | 3,187 / 3,187 |
| Ledger / Wallet effects | 1,245 / 3,187 |
| Completion sources / ticket completions | 6,495 / 2,524 |
| Future multi-draw items | 206 |
| Duplicate/cross-player effects | 0 |
| Schedule misses / maximum drift | 0 / 0 seconds |

Average accepted load was 34.2 tickets per authoritative outcome, 84.5 evaluations per outcome, and 41.4 aggregate settlements per outcome. These averages describe this mixed-product workload; they are not a single-draw burst claim.

Latency in milliseconds:

| Stage | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: |
| Scheduled draw to result | 388.08 | 828.58 | 1,640.55 | 1,640.55 |
| Result to Math evaluation | 463.59 | 1,954.79 | 2,926.15 | 4,254.02 |
| Evaluation to aggregate SettlementInput | 751.94 | 14,017.90 | 21,245.60 | 22,996.15 |
| SettlementInput to Settlement | 776.23 | 1,673.85 | 2,716.64 | 3,442.58 |
| Result to Wallet | 2,683.89 | 17,527.17 | 24,116.64 | 25,991.93 |
| Result to Completion | 2,870.00 | 17,959.96 | 24,931.35 | 968,490.33 |

The long Completion maximum includes legitimate multi-draw parent duration and must not be interpreted as a single-draw processing latency. Scheduled result p95 passed the one-second target. Downstream latency exceeded the preferred and five-second objectives and remains an open HIGH anomaly.

Financial reconciliation was exact: due stake, settled stake, Wallet stake, and Wallet impact were 53,217,500 minor units; Ledger debits and credits both equaled 49,634,080 minor units. Remaining exposure belonged only to future multi-draw participations.

## 2,000-Player Sustained Tier

The 2,000-player tier ran for the full 60 minutes. All correctness gates passed, but the tier failed latency and PostgreSQL connection-budget gates.

| Measure | Result |
| --- | ---: |
| Attempted / accepted tickets | 9,852 / 7,953 |
| Ticket items | 21,044 |
| Authoritative outcomes | 157 |
| Due evaluations / Math certificates | 20,841 / 20,841 |
| Aggregate SettlementInputs / Settlements | 10,354 / 10,354 |
| Ledger / Wallet effects | 3,812 / 10,354 |
| Completion sources / ticket completions | 20,826 / 7,879 |
| Future multi-draw items | 203 |
| Duplicate/cross-player effects | 0 |
| Schedule misses / maximum drift | 0 / 0 seconds |

Latency in milliseconds:

| Stage | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: |
| Scheduled draw to result | 398.99 | 1,429.65 | 1,919.70 | 2,094.89 |
| Result to Math evaluation | 853.82 | 4,144.56 | 7,377.10 | 8,687.85 |
| Evaluation to aggregate SettlementInput | 2,106.60 | 23,169.94 | 31,052.34 | 38,015.48 |
| SettlementInput to Settlement | 1,102.52 | 4,781.53 | 6,552.06 | 8,371.88 |
| Result to Wallet | 4,805.04 | 31,149.29 | 39,687.57 | 44,823.86 |
| Result to Completion | 5,047.56 | 31,840.71 | 41,056.68 | 2,172,369.46 |

PostgreSQL reached 101 observed sessions, 44 active sessions, and 24 lock waiters. Eight canonical acceptance requests returned transient `too many clients already` errors. Deadlocks remained zero. This is a connection-budget ceiling; `max_connections` was not increased.

RabbitMQ active queues peaked at 123 messages and drained without a growing cross-draw backlog. The existing 312-message Settlement DLQ was static pre-campaign disposable evidence, not created by this campaign. Recovery-required scheduler backlog remained zero.

Financial reconciliation remained exact: due and settled stake were 167,536,900 minor units; Ledger debits and credits were both 157,824,965; duplicate outcomes, evaluations, settlements, completion sources, Ledger effects, and Wallet effects were all zero. One Hot Spot 20-draw ticket retained 300 minor units for three not-yet-due participations, which is correct future exposure rather than stranded funds.

## Burst Decision

The requested 500, 1,000, 2,500, 5,000, and 10,000 single-draw bursts were not run. The elevated sustained tier had already reached a clearly characterized environment capacity ceiling and failed both the scheduled-result p95 and downstream latency gates. Continuing to larger bursts would have violated the sequential stop rule and could not produce a defensible capacity claim.

Therefore:

- highest verified sustained capacity: 500-player mixed-product tier
- highest verified average tickets per authoritative result: 34.2
- highest verified single-draw burst capacity: not established
- highest sustainable requested burst: not established

## Bottleneck and Next Step

The primary bottlenecks are PostgreSQL connection-budget saturation and evaluation-to-aggregate assembly latency. At elevated load, evaluation processing itself remained comparatively small (p95 107.03 ms), while evaluation-to-aggregate reached p95 23.17 seconds. Settlement queue and processing added further pressure but did not corrupt or duplicate effects.

The next package should reduce and bound database connection demand across the qualification Game Engine, Settlement worker, and financial services, then optimize or batch the aggregate SettlementInput readiness query without changing financial authority boundaries. It must preserve connection headroom and must not raise PostgreSQL `max_connections` as a substitute for admission control. After remediation, rerun the 2,000-player tier before admitting the burst ladder.

## Validation and Isolation

- Settlement Service build/tests: PASS
- Game Engine solution build/tests: PASS
- repository lint: PASS
- TypeScript compile: PASS
- PR-05F bounded Math admission: PASS
- PR-05D wallet lock ordering: PASS, 0 deadlocks
- aggregate Settlement: PASS
- Hot Spot multi-draw: PASS
- Ledger durable posting: PASS
- Credit Wallet Settlement authority: PASS
- Ticket Completion: PASS with automatic recovery intentionally disabled for its manually staged fixture
- migrations 1-147 run/validate: PASS; PR-05G adds no migration
- integrated runtime: PASS with explicit host-mapped service URLs and disposable-database approval
- `git diff --check`: PASS
- CSPRNG source SHA-256: `2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c`

The canonical Next.js Turbopack build could not be completed in this execution sandbox: the first attempt could not fetch Google Fonts and the escalated attempt was denied an internal port bind (`Operation not permitted`). A webpack fallback is not equivalent for this repository and rejected an existing `node:crypto` import. PR-05G changes no frontend application code; this environmental build limitation does not alter the .NET, TypeScript, runtime, or qualification results above.

Qualification activation teardown was complete: active pilot product versions 0, qualification activation rows 0, and qualification availability rows 0. Production Settlement activation remained disabled.

## Changed Files

PR-05G changes are limited to:

- `services/settlement-service/Application/AutomaticFinancialRecoveryHostedService.cs`
- `services/settlement-service/Application/SettlementRecoveryService.cs`
- `services/settlement-service/Configuration/ServiceConfiguration.cs`
- `services/settlement-service/Controllers/HealthEndpoints.cs`
- `services/settlement-service/Infrastructure/FinancialInstructionRepository.cs`
- `services/settlement-service/Program.cs`
- `services/settlement-service/tests/SettlementService.Tests/Program.cs`
- `scripts/qa/pr05g-automatic-financial-recovery.ts`
- `scripts/qa/lib/credit-wallet-settlement-fixture.ts`
- `scripts/qa/pr05-managed-runtime-qualification.mjs`
- `docker-compose.yml`
- `docker-compose.production.yml`
- `package.json`
- this report

No migration was added. No commit was created.
