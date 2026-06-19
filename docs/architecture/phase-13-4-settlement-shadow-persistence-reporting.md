# Phase 13.4 - Settlement Shadow Persistence And Mismatch Reporting

## Purpose

Phase 13.4 persists Settlement Service shadow execution evidence so future authority-transfer decisions can be based on observed match, mismatch, and failure rates over time.

## Non-Authority Rule

Shadow persistence is operational evidence only. It does not update tickets, release credit, post ledger entries, update balances, or emit production financial outbox events.

## Persistence Model

Tables:

- `settlement_shadow_runs`
- `settlement_shadow_mismatches`
- `settlement_shadow_failures`

The Settlement Service writes these tables through Supabase REST when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are configured. If persistence is unavailable, the service logs the failure and still does not affect monolith settlement.

## Mismatch Classification

| Field | Category | Severity |
| --- | --- | --- |
| `calculatedOutcome` | `OUTCOME_MISMATCH` | `CRITICAL` |
| `grossPayout` | `PAYOUT_MISMATCH` | `CRITICAL` |
| `netAmount` | `NET_AMOUNT_MISMATCH` | `CRITICAL` |
| `stakeAmount` | `STAKE_MISMATCH` | `WARNING` |
| `currency` | `CURRENCY_MISMATCH` | `CRITICAL` |
| unknown | `UNKNOWN_MISMATCH` | `WARNING` |

## Operational APIs

Protected by `system.admin`:

- `GET /api/settlement-shadow/summary`
- `GET /api/settlement-shadow/mismatches`
- `GET /api/settlement-shadow/failures`

Filters:

- mismatches: `ticketId`, `gameId`, `from`, `to`, `limit`
- failures: `ticketId`, `from`, `to`, `limit`

## Operational Scripts

- `npm run ops:settlement-shadow-summary`
- `npm run ops:settlement-shadow-mismatches`
- `npm run ops:settlement-shadow-failures`

## Readiness Metrics

Metrics:

- `MATCH_RATE`
- `MISMATCH_RATE`
- `FAILURE_RATE`

Default thresholds:

- `READY`: mismatch rate `< 0.1%` and failure rate `< 0.1%`
- `WARNING`: mismatch rate `>= 0.1%` or failure rate `>= 0.1%`
- `BLOCKED`: mismatch rate `>= 1%` or any critical mismatch exists

Threshold environment variables:

- `SETTLEMENT_SHADOW_READY_MISMATCH_RATE`
- `SETTLEMENT_SHADOW_READY_FAILURE_RATE`
- `SETTLEMENT_SHADOW_BLOCKED_MISMATCH_RATE`

## Remaining Gaps

- No UI yet.
- No mismatch acknowledgement workflow yet.
- No automated authority cutover.
- No production financial event publishing from shadow mode.
