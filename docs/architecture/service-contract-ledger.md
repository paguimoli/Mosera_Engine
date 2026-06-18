# Ledger Service Contract

## Purpose

This contract defines the internal Ledger boundary that will later map to an extracted Ledger Service. Production traffic remains in the monolith in Phase 13.1.

## Ownership

Ledger owns:

- Financial ledger posting interface.
- Financial ledger reversal interface.
- Ledger transaction query interface.
- Ledger audit trail access.
- Ledger event contract and audit traceability.

Ledger does not own wallet policy, cashier lifecycle, settlement result calculation, player lifecycle, commission calculation, accounting weekly close, or authentication.

## Commands

### Post Ledger Entry

Internal entry point: `postLedgerEntry`

Input:

- `walletId`
- `transactionType`
- `direction`
- `amount`
- optional reference
- optional `idempotencyKey`
- optional `metadata`

Output:

- Immutable ledger entry with calculated `balanceAfter`.

Requirements:

- Amount uses integer minor units.
- Caller does not calculate `balanceAfter`.
- Ledger insert and wallet materialized balance update remain atomic through `post_financial_ledger_entry`.
- Duplicate idempotency keys return the existing ledger entry as success.

Events:

- Existing financial outbox events where integrated by caller.

Failure modes:

- Invalid amount.
- Invalid direction or transaction type.
- Wallet not found.
- Wallet inactive.
- Persistence failure.

Retry safety:

- Safe when `idempotencyKey` is supplied.

External endpoint mapping:

- `POST /v1/ledger/entries`

### Reverse Ledger Entry

Internal entry point: `reverseLedgerEntry`

Input:

- `ledgerEntryId`
- `reason`
- optional `actorUserId`

Output:

- Reversal ledger entry.

Requirements:

- Reversals are append-only.
- Original ledger rows are never updated or deleted.

External endpoint mapping:

- `POST /v1/ledger/entries/{ledgerEntryId}/reverse`

### Get Ledger Transaction

Internal entry point: `getLedgerTransaction`

Input:

- `ledgerEntryId`

Output:

- Ledger entry or `null`.

External endpoint mapping:

- `GET /v1/ledger/entries/{ledgerEntryId}`

### Get Ledger Audit Trail

Internal entry point: `getLedgerAuditTrail`

Input:

- `ledgerEntryId`

Output:

- Reconstructable audit trail including source records, outbox events, and gaps.

External endpoint mapping:

- `GET /v1/ledger/entries/{ledgerEntryId}/audit`

## Correlation And Actor Requirements

Financial posting callers should supply correlation IDs through metadata or the enclosing workflow. Actor IDs should be supplied for manual adjustments and reversals when available.

## Extraction Notes

The first extracted Ledger Service must wrap the existing hardened SQL RPCs. It must not independently calculate balances.
