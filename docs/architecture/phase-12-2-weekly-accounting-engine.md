# Phase 12.2 Weekly Accounting Engine

## Purpose

Phase 12.2 implements weekly accounting snapshots for the North American credit model.

The engine generates authoritative weekly figures for:

- Players
- Agents
- Masters
- Super Masters

It remains inside the Next.js/Supabase monolith. No production traffic is routed to .NET services.

## Accounting Model

New table:

- `weekly_accounting_snapshots`

Snapshots are immutable per account/week/currency through a unique key:

```text
account_id + week_start + week_end + currency
```

Money fields use integer minor units:

- `opening_balance`
- `closing_balance`
- `settled_wins`
- `settled_losses`
- `net_result`
- `pending_exposure`

No floating point money values are introduced.

## Weekly Figure Formula

For each player:

```text
settledWins = sum(balanceImpact where balanceImpact > 0)
settledLosses = abs(sum(balanceImpact where balanceImpact < 0))
netResult = sum(balanceImpact)
ticketCount = count(distinct ticketId)
openingBalance = currentCreditWalletBalance - netResult
pendingExposure = sum(active reservation remainingExposure)
```

Source of settled activity:

- `credit_settlement_applications`

Only settlement applications created inside the weekly window are included.

Open tickets are not included in settled figures. Active reservations remain separate as pending exposure.

## Carry Balance Mode

Carry balance mode records the weekly snapshot and leaves the credit wallet balance unchanged.

The period result rolls forward naturally because the wallet balance remains materialized state.

## Zero Balance Mode

Zero balance mode records the weekly snapshot and resets player CREDIT wallet balance to zero.

The reset uses:

- `post_financial_ledger_entry(...)`
- `ZERO_BALANCE_CREDIT`
- `ZERO_BALANCE_DEBIT`

The reset is idempotent with a deterministic ledger idempotency key:

```text
weekly-zero:{accountId}:{weekStart}:{weekEnd}:{currency}
```

No TypeScript code directly mutates wallet balances.

## Weekly Close Process

The weekly close RPC is:

- `generate_weekly_accounting_snapshots(...)`

Inputs:

- `week_start`
- `week_end`
- `account_scope`
- `currency`
- `close_mode`
- `correlation_id`

The RPC:

1. Validates the weekly window and currency.
2. Builds scoped accounts.
3. Calculates player settled activity.
4. Calculates active pending exposure.
5. Rolls figures up through the hierarchy.
6. Applies zero-balance ledger entries when required.
7. Inserts snapshots idempotently.
8. Emits outbox events for newly generated snapshots.

## Hierarchy Rollups

Rollups use `accounts.parent_account_id`.

Player figures roll up:

```text
Player -> Agent -> Master Agent -> Super Master
```

Rollup fields:

- `netResult`
- `ticketCount`
- `pendingExposure`
- `settledWins`
- `settledLosses`
- opening and closing balances aggregated from descendant players

Commissions are intentionally not calculated in this phase.

## Idempotency

Snapshot idempotency is enforced by:

- `weekly_accounting_snapshots_account_week_currency_unique`

Zero-balance financial effects are idempotent through hardened ledger posting idempotency keys.

Repeated close execution for the same account/week/currency returns existing snapshots and does not duplicate financial effects.

## Outbox Events

Events are recorded through the existing outbox pattern:

- `accounting.snapshot.generated`
- `accounting.week.closed`

No direct RabbitMQ publishing was added.

## APIs

Added protected APIs:

- `GET /api/accounting/weekly-summary`
- `GET /api/accounting/account/{accountId}/weekly-summary`
- `POST /api/accounting/close-week`

Permissions:

- read endpoints require `reports.view`
- close endpoint requires `ledger.post_adjustment`

## North American Model Compatibility

This phase assumes the North American credit model:

- no real-money deposits
- no real-money withdrawals
- credit balance is operational result state
- pending exposure remains separate from settled result

The implementation keeps close mode explicit so an Asian credit model can be added later without forking the accounting domain.

## Limitations

- Settlement applications must exist before weekly accounting can calculate settled figures.
- Legacy `weekly_account_summaries` remain in place and are not replaced in this phase.
- Commission calculation is not implemented.
- Weekly close does not lock an external accounting period object.
- Resettlement reversal accounting is not fully automated.
- Manual DB validation requires applying Phase 12.0, 12.1, and 12.2 migrations.

## Validation Checklist

- Apply `20260617000300_create_weekly_accounting_snapshots.sql`.
- Create or identify settled credit activity in `credit_settlement_applications`.
- Run `POST /api/accounting/close-week`.
- Verify `weekly_accounting_snapshots` rows are created.
- Verify player settled wins, losses, net result, and ticket count.
- Verify Agent, Master, and Super Master rollups.
- Re-run close and verify no duplicate snapshots.
- For carry mode, verify wallet balance is unchanged.
- For zero balance mode, verify zero-balance ledger entry exists and wallet balance is zero.
- Verify outbox contains accounting events for newly generated snapshots.
