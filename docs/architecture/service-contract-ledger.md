# Ledger Service Contract

## Authority

Ledger Service owns the canonical `ledger.posting.v1` HTTP boundary. Contract
version is `1.0.0`; service implementation version is reported separately.
Settlement and the Financial Platform are consumers and may not redefine
posting, reversal, balance, journal, or idempotency behavior.

## Commands

### Post Ledger Entry

`POST /v1/ledger/entries` accepts the canonical `CreateLedgerEntryRequest` and
returns `LedgerEntryResponse`. `POST /v1/ledger/entries/{id}/reverse` accepts the
canonical reversal contract. Requests carry `Idempotency-Key` and
`x-correlation-id`; financial instruction identity supplies causation.

### Reverse Ledger Entry

Reversal uses the same versioned Ledger boundary and returns an immutable
opposing entry linked to the original entry and hash.

Ledger validates canonical request hashes, currency, account role, posting rule,
and immutable references. It calculates balances and balanced journal entries
inside its durable transaction. Callers never calculate `balanceAfter`.

## Queries

### Get Ledger Transaction

- `GET /v1/ledger/entries/{id}` returns the immutable entry.
- Posting request, attempt, recovery, replay, reconciliation, and audit queries
  expose Ledger-owned evidence without transferring mutation authority.
- `GET /v1/ledger/health` reports readiness, contract version, and authority
  owner.

## Guarantees

- Duplicate identical idempotency requests return existing evidence.
- Conflicting idempotency payloads fail closed.
- Corrections use append-only reversal entries.
- Correlation is preserved across HTTP, persistence, outbox, RabbitMQ, workers,
  and logs.
- Retry, recovery, and replay use the original canonical request identity.
- Ledger owns its request and response DTOs; consumers serialize the documented
  wire contract without defining a competing authority.

The complete service-boundary registry is maintained in
`src/architecture/service-boundaries/cross-service-contracts.ts`.
