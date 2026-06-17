# Phase 12.4 - Reconciliation Engine

## 1. Purpose

Phase 12.4 introduces an operational reconciliation engine for the North American credit launch path. Its job is to compare independently persisted facts across tickets, credit reservations, settlement applications, weekly accounting snapshots, commission run details, and audit/event trails where available.

The engine does not replace any source-of-truth workflow. It produces append-only reconciliation runs and findings so operators can prove consistency, identify drift, and investigate launch-blocking financial discrepancies before weekly close, commission review, and beta operations.

## 2. Scope

Implemented scope:

- Reconciliation run persistence.
- Append-only reconciliation findings.
- Credit exposure checks.
- Reservation release balance checks.
- Ticket-to-reservation link checks where the ticket schema is available.
- Settlement application existence checks for settled credit-backed tickets.
- Weekly accounting checks against credit settlement applications.
- Commission detail checks against weekly accounting snapshots.
- Protected API endpoints for running and reading reconciliation.
- Outbox events for run completion, run failure, and warning/failure findings.

Out of scope:

- No production traffic is routed to .NET services.
- No business logic moves out of the monolith.
- No real-money cashier reconciliation is added.
- No infrastructure changes are made.
- No automatic correction or financial mutation is performed.

## 3. Source-of-Truth Inputs

The reconciliation engine reads:

- `credit_reservations`
- `credit_settlement_applications`
- `tickets`, when the current schema exposes reservation linkage
- `weekly_accounting_snapshots`
- `commission_run_details`
- `outbox_events`, for emitted reconciliation audit events

Money values are treated as integer minor units. The engine does not use floating-point, decimal, or real-money cashier calculations.

## 4. Database Model

`reconciliation_runs` records each execution:

- run type
- scope type and optional scope id
- optional week window
- optional currency
- status
- pass/fail/warning counters
- correlation id
- timestamps

`reconciliation_run_findings` records append-only check output:

- severity: `PASS`, `WARNING`, or `FAIL`
- check code
- entity type and id
- expected amount
- actual amount
- currency
- message
- metadata

Findings are never edited or deleted by the engine.

## 5. Run Types

Supported run types:

- `CREDIT`
- `SETTLEMENT`
- `ACCOUNTING`
- `COMMISSION`
- `FULL`

`FULL` runs all implemented checks.

## 6. Scopes

Supported scope types:

- `GLOBAL`
- `ACCOUNT`
- `PLAYER`
- `AGENT`
- `MASTER`
- `WEEK`

The current implementation records scope metadata and applies week/currency filters where checks have compatible source timestamps or week fields. Deeper hierarchy-specific filtering remains a follow-up enhancement.

## 7. Checks

### Credit Exposure

Check code: `CREDIT_PENDING_EXPOSURE`

Compares active reservation remaining exposure against the player credit summary pending exposure.

Expected:

```text
sum(active credit_reservations.remaining_exposure)
```

Actual:

```text
credit summary pendingExposure
```

### Reservation Settlement

Check code: `RESERVATION_RELEASE_BALANCE`

Verifies:

```text
reserved_amount = released_amount + remaining_exposure
```

This proves release operations did not over-release or leave unreconciled exposure.

### Ticket Reservation

Check code: `TICKET_RESERVATION_LINK`

Verifies that credit-backed tickets have a reservation id and that the referenced reservation points back to the same ticket id.

If the current ticket schema does not expose the required columns, the check emits a warning instead of failing the run.

### Settlement Application

Check code: `SETTLEMENT_APPLICATION_EXISTS`

Verifies settled tickets with reservation linkage have a `credit_settlement_applications` row.

### Weekly Accounting

Check code: `WEEKLY_ACCOUNTING_NET_RESULT`

For player weekly accounting snapshots, compares:

```text
weekly_accounting_snapshots.net_result
```

against:

```text
sum(credit_settlement_applications.balance_impact)
```

for the same player, currency, and week window.

### Commission

Check codes:

- `COMMISSION_DETAIL_SNAPSHOT`
- `COMMISSION_AMOUNT_FORMULA`

Verifies commission run details reference existing weekly snapshots and that loss-based percentage commission amounts match:

```text
max(0, -net_result) * commission_percentage_basis_points / 10000
```

The result is floored to integer minor units.

## 8. API Surface

Protected APIs:

- `POST /api/reconciliation/run`
- `GET /api/reconciliation/run/{runId}`
- `GET /api/reconciliation/findings`
- `GET /api/reconciliation/summary`

Run creation requires the existing `ledger.post_adjustment` permission because it creates persistent audit rows and outbox events. Read endpoints require `reports.view`.

## 9. Events

The engine uses the existing outbox pattern only.

Events:

- `reconciliation.run.completed`
- `reconciliation.run.failed`
- `reconciliation.finding.created`

`reconciliation.finding.created` is emitted for warning and failure findings. Passing findings remain queryable in the database without producing extra event volume.

## 10. Idempotency

Repeated reconciliation runs intentionally create new run records. This preserves an audit trail of what the platform looked like at each execution time.

The engine does not mutate financial state, reservations, tickets, settlements, accounting snapshots, or commission records. Therefore duplicate execution cannot duplicate financial effects.

## 11. Severity Model

`PASS` means the checked invariant matched.

`WARNING` means the engine could not prove the invariant, usually because a source table or column is unavailable, or there is no data yet for the requested scope.

`FAIL` means the engine found a concrete mismatch or missing required relationship.

## 12. Operational Workflow

Recommended beta workflow:

1. Run `FULL` reconciliation after settlement.
2. Review all `FAIL` findings before weekly close.
3. Review all `WARNING` findings before commission generation.
4. Run `ACCOUNTING` after weekly snapshots are generated.
5. Run `COMMISSION` after commission runs are generated.
6. Export findings for operator signoff before beta weekly close.

## 13. Limitations

- Scope filtering is initially strongest for week and currency. Hierarchy-aware account filtering should be expanded after hierarchy reporting stabilizes.
- Ticket reconciliation depends on the active ticket schema exposing reservation linkage.
- Commission reconciliation validates the implemented loss-based formula only.
- The engine reports inconsistencies but does not repair them.
- Ledger and cashier reconciliation are not expanded in this phase because the launch path is credit-based and real-money cashier is out of scope.

## 14. Future .NET Migration Notes

The reconciliation engine can later become a service boundary after the monolith contracts stabilize. Initial extraction should read the same source tables and produce the same finding model. It must not independently mutate credit, ledger, settlement, accounting, or commission records.

## 15. Validation Checklist

- Migration creates `reconciliation_runs`.
- Migration creates `reconciliation_run_findings`.
- Findings are append-only.
- Money fields use integer minor units.
- API routes are protected.
- Reconciliation run creates persisted findings.
- Reconciliation run completion emits outbox event.
- Warning/failure findings emit outbox event.
- Existing business flows remain unchanged.
- No .NET routing changes.
- No infrastructure changes.
