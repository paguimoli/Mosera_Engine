# Phase 13.5 - Ledger Service Shadow Mode

## Purpose

Phase 13.5 creates a Ledger Service shadow-mode foundation. The monolith and the hardened `post_financial_ledger_entry` RPC remain authoritative. Ledger Service can independently validate ledger posting payloads, compare them with monolith results, and persist operational evidence for future extraction decisions.

## Authority Boundary

Ledger Service shadow mode must not:

- update wallet balances
- insert authoritative financial ledger entries
- reverse ledger entries
- emit production financial outbox events
- become the ledger system of record

The only allowed persistence is shadow evidence in `ledger_shadow_runs`, `ledger_shadow_mismatches`, and `ledger_shadow_failures`.

## Shadow Execution Flow

1. The monolith posts the authoritative ledger entry through the existing service and database RPC.
2. After successful posting, the monolith invokes Ledger Service best-effort when `LEDGER_SHADOW_MODE_ENABLED=true`.
3. Ledger Service validates the submitted ledger shape.
4. Ledger Service compares the shadow-calculated result against the expected monolith result.
5. Ledger Service persists MATCH, MISMATCH, or FAILURE evidence if Supabase shadow tables are configured.
6. Shadow failures are logged but never fail production ledger posting.

## Contract

`POST /v1/ledger/shadow/execute`

Input:

- `correlationId`
- `transactionId`
- `accountId`
- `walletId`
- `entryType`
- `direction`
- `amountMinor`
- `currency`
- `actorId`
- `idempotencyKey`
- `metadata`
- `expectedMonolithResult`

Output:

- `success`
- `shadowLedgerRunId`
- `calculatedResult`
- `comparisonStatus`
- `mismatches`
- `correlationId`

All money uses integer minor units. Floating point and decimal money fields are not used.

## Validation Rules

Ledger Service validates:

- transaction id is present
- account id is present
- entry type is a known ledger transaction type
- amount is a positive integer minor-unit value
- currency is an uppercase ISO-4217 code
- direction is `CREDIT` or `DEBIT` when provided

Validation failure creates a shadow failure record when persistence is available.

## Mismatch Categories

- `AMOUNT_MISMATCH`: shadow amount differs from monolith amount.
- `CURRENCY_MISMATCH`: shadow currency differs from monolith currency.
- `ENTRY_TYPE_MISMATCH`: transaction type or direction differs.
- `ACCOUNT_MISMATCH`: account id differs.
- `IDEMPOTENCY_MISMATCH`: idempotency key differs.
- `UNKNOWN_MISMATCH`: fallback category for future fields.

Severity:

- `CRITICAL`: amount, currency, entry type, direction, or account mismatch.
- `WARNING`: idempotency mismatch or unknown mismatch.
- `INFO`: reserved for future non-blocking differences.

## Reporting

Protected APIs:

- `GET /api/ledger-shadow/summary`
- `GET /api/ledger-shadow/mismatches`
- `GET /api/ledger-shadow/failures`

Authorization requires `system.admin`, which includes Super Admin and Operations Admin via existing permission resolution.

## Readiness Metrics

The summary endpoint reports:

- `MATCH_RATE`
- `MISMATCH_RATE`
- `FAILURE_RATE`

Default thresholds:

- READY: mismatch rate `< 0.1%` and failure rate `< 0.1%`, with no critical mismatches.
- WARNING: mismatch rate or failure rate at or above `0.1%`.
- BLOCKED: mismatch rate at or above `1%`, or any critical mismatch is present.

Thresholds are configurable with:

- `LEDGER_SHADOW_READY_MISMATCH_RATE`
- `LEDGER_SHADOW_READY_FAILURE_RATE`
- `LEDGER_SHADOW_BLOCKED_MISMATCH_RATE`

## Operational Commands

- `npm run ops:ledger-shadow-summary`
- `npm run ops:ledger-shadow-mismatches`
- `npm run ops:ledger-shadow-failures`

These commands require `OPERATIONS_SESSION_TOKEN` or `QA_ADMIN_SESSION_TOKEN`.

## QA

- `npm run qa:ledger-shadow`
- `npm run qa:ledger-shadow-reporting`

`qa:ledger-shadow-reporting` requires the ledger shadow migration to be applied and `QA_ADMIN_SESSION_TOKEN` to be set.

## Limitations

- Ledger Service does not connect to the authoritative financial ledger RPC.
- Ledger Service does not independently reconstruct wallet balances.
- Shadow mode compares command/result shape, not full historical ledger replay.
- Monolith integration is best effort and intentionally cannot fail production posting.

## Future Extraction Notes

Future authority transfer requires sustained READY shadow metrics, reconciliation evidence, rollback procedures, feature-flagged routing, operational dashboards, and proof that Ledger Service can safely wrap or replace the existing hardened RPC without independently calculating balances incorrectly.
