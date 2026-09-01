# PR-05B Ticket/Draw Aggregate Settlement Remediation

Status: `PR_05B_TICKET_DRAW_AGGREGATE_SETTLEMENT_PASS`

## Scope

PR-05B preserves immutable item-level Math Evaluation evidence while changing the
Fast Keno financial boundary from one settlement request per wager item to one
canonical aggregate per accepted ticket and authoritative draw. Settlement,
Ledger, Wallet, and Completion remain the existing authorities. Hot Spot retains
its per-play financial and cap semantics.

No sustained 30/60-minute campaign was run and this result makes no production
capacity claim.

## Canonical Flow

1. Every due Fast Keno wager item is evaluated independently.
2. The immutable Math Evaluation certificates are grouped by ticket and draw.
3. One canonically hashed aggregate binds the exact product, manifest, paytable,
   outcome, provider, configuration, currency, stake, item result, and certificate
   lineage.
4. Item returns are summed and the immutable ticket-level configured cap is
   applied once to the pre-cap aggregate return.
5. One aggregate SettlementInput enters the existing Settlement Authority.
6. Settlement produces one canonical Ledger and Wallet path for the aggregate.
7. Completion requires the durable settlement, ledger, and committed wallet
   evidence while retaining item-level completion attribution.

The aggregate idempotency scope binds ticket, draw, and canonical aggregate hash.
Identical retries reuse the persisted result; conflicting payloads fail closed.

## Persistence

- Migration 142 adds immutable ticket/draw aggregate SettlementInput persistence,
  item-evidence attribution, unique aggregate scope/hash constraints, indexes, and
  update/delete prevention.
- Migration 143 binds aggregate completion-source lineage to the canonical
  aggregate financial result.
- Existing historical per-item settlement evidence is not rewritten.

Fresh-database apply and upgrade-path validation completed through migration 143.
The migration validator reported 1,385 checks, zero failures, and zero warnings.

## Correctness Evidence

Focused QA covers one, five, ten, and twenty item aggregation; wins, losses,
pushes/refunds, mixed and opposing results; below/exactly/above-cap arithmetic;
configuration-derived cap values; duplicate and conflicting requests; concurrent
finalization; restart/retry boundaries; append-only enforcement; and no duplicate
Settlement, Ledger, Wallet, or Completion effects.

Fast Keno applies the cap once after item-return aggregation. Hot Spot continues
to combine base and Bullseye payout within each play and applies its cap per play.
The Settlement item PUSH path returns accepted stake; aggregate cap handling does
not leak back into item-level semantics.

The short diagnostic reconciled:

- reserved: 1,754,300 minor units
- due/captured/settled stake: 1,025,500 minor units
- future reservation remaining: 728,800 minor units
- gross payout: 1,070,425 minor units
- net result: 44,925 minor units
- Ledger debits and credits: 1,070,425 minor units each

## Short Diagnostic

Campaign: `pr05b-final-diagnostic-20260827T1855Z`

Workload: 500 configured players, 0.5 minutes, 69 accepted tickets, 222 wager
items, 108 due item Math certificates, and 33 due aggregate financial units.
Exactly 33 SettlementInputs, settlements, wallet effects, and terminal ticket
completions were produced. All duplicate counters were zero.

| Stage | p50 ms | p95 ms | p99 ms | max ms |
| --- | ---: | ---: | ---: | ---: |
| Result to Evaluation | 495.07 | 787.61 | 815.65 | 815.65 |
| Evaluation to Aggregate | 38.84 | 64.07 | 65.90 | 65.90 |
| Aggregate to Settlement | 731.67 | 900.34 | 999.96 | 999.96 |
| Settlement to Ledger | 79.07 | 132.73 | 138.68 | 138.68 |
| Ledger to Wallet | 59.44 | 125.58 | 153.74 | 153.74 |
| Result to Wallet | 1,459.82 | 1,827.88 | 1,860.62 | 1,860.62 |

Result-to-Wallet p95 improved by 4,540.61 ms (71.3%) from the retained PR-05A
best diagnostic of 6,368.49 ms and is below the five-second operational ceiling.
Peak PostgreSQL usage was 59 connections, lock waiters remained zero, and all
observed RabbitMQ ready/unacknowledged counts remained zero.

## Safety And Teardown

- Qualified CSPRNG source hash remained
  `2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c`.
- Provider fallback count was zero.
- Pilot products were restored to `PUBLISHED / INACTIVE / UNASSIGNED`.
- PR-04A and PR-05 qualification activation rows were removed.
- PR-05 qualification availability rows were inactive/removed.
- Production Settlement activation remained disabled.

## Limitations

The diagnostic is intentionally short and does not qualify sustained throughput,
capacity, high-percentile behavior under long duration, or the proposed 500 to
10,000 tickets-per-draw burst envelopes. The next package may run the controlled
sustained PR-04B/PR-05 scale campaign against this aggregate boundary.
