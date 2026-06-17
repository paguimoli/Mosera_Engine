# Phase 12.3 Commission Accounting Engine

## Purpose

Phase 12.3 implements the commission accounting engine for the North American credit model.

Commissions are calculated from weekly accounting snapshots only. The engine does not calculate from tickets, settlement records, or credit reservations directly.

## Authoritative Source

Commission source of truth:

- `weekly_accounting_snapshots`

Excluded direct sources:

- tickets
- settlement records
- credit reservations

This keeps commission calculation downstream of weekly accounting close and prevents conflicting financial figures.

## Commission Model

Supported commission type:

- `LOSS_BASED_PERCENTAGE`

The percentage is stored as integer basis points:

```text
10000 = 100.00%
1000 = 10.00%
250 = 2.50%
```

No floating point money values are used.

## Calculation Formula

For a weekly snapshot:

```text
lossBasis = max(0, -netResult)
commissionAmount = floor(lossBasis * percentageBasisPoints / 10000)
```

Meaning:

- If the downline/player group lost for the week, `netResult` is negative and commission may be due.
- If the downline/player group won or broke even, commission is zero.
- Pending exposure is excluded.

## Hierarchy Behavior

Phase 12.2 snapshots already roll player figures up through:

```text
Player -> Agent -> Master Agent -> Super Master
```

Phase 12.3 commission details are generated for accounts with active commission plans and eligible weekly snapshots.

Initial eligible account types:

- `AGENT`
- `MASTER_AGENT`

Super Master commission ownership is intentionally left for a later operator-specific model.

## Idempotency

Commission run idempotency:

- `commission_runs.week_start + week_end + currency` is unique.

Commission detail idempotency:

- `commission_run_details.run_id + account_id + snapshot_id` is unique.

Repeated run execution does not duplicate details or financial effects.

## Adjustments

Manual adjustments are append-only:

- `commission_adjustments`

Required adjustment fields:

- account id
- run id
- integer minor-unit adjustment amount
- reason code
- actor user id when available
- timestamp

No deletion or in-place mutation is used for corrections.

## Events

Events are recorded through the existing outbox pattern:

- `commission.run.completed`
- `commission.adjustment.created`

No direct RabbitMQ publishing was added.

## APIs

Added protected APIs:

- `POST /api/commissions/run`
- `GET /api/commissions/run/{runId}`
- `GET /api/commissions/account/{accountId}`
- `POST /api/commissions/adjust`

Permissions:

- read endpoints require `reports.view`
- run and adjustment endpoints require `ledger.post_adjustment`

## Limitations

- Commission plan creation APIs from earlier phases remain compatible and are not fully redesigned around basis points.
- Existing legacy `weekly_commission_records` remain in place.
- Commission payout ledger posting is not implemented in this phase.
- Reversal of commission runs is modeled by status but not automated yet.
- Super Master commission behavior is not implemented until operator-specific rules are confirmed.
- Manual DB validation requires Phase 12.2 snapshots to exist first.

## Validation Checklist

- Apply `20260617000400_create_commission_accounting_engine.sql`.
- Create or identify a commission plan for an Agent or Master.
- Ensure `weekly_accounting_snapshots` exist for the target week.
- Run `POST /api/commissions/run`.
- Verify `commission_runs` row is created.
- Verify `commission_run_details` rows are created from snapshots.
- Re-run the same week/currency and verify details are not duplicated.
- Create adjustment with `POST /api/commissions/adjust`.
- Verify `commission_adjustments` contains an append-only row.
- Verify outbox contains commission events.
