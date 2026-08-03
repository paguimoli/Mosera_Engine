# BF-7.2 Cross-Service Contract Integrity

## Contract Authority

Every active service boundary has one contract identity, owner, version,
idempotency identity, correlation model, causation model, canonical source, and
readiness source. The machine-readable registry is
`src/architecture/service-boundaries/cross-service-contracts.ts`.

Contract version `1.0.0` is frozen for the current Auth, Game Engine,
Settlement, Ledger, Credit Wallet, Ticket, Financial Platform, Operational
Governance, Worker, Outbox, and RabbitMQ boundaries. Evolution requires a new
explicit contract version; compatibility is never inferred from payload shape.

## Consolidations

- RabbitMQ is the sole production event publisher. The no-op publisher that
  could acknowledge delivery without a broker has been removed.
- PostgreSQL is the sole outbox repository whenever `DATABASE_URL` is present.
  Create, read, dispatch, and status transitions no longer split between
  PostgreSQL and the legacy Supabase adapter.
- The legacy outbox adapter remains only for explicit non-production operation
  without `DATABASE_URL`.
- RabbitMQ messages carry one canonical `1.0.0` envelope: outbox event ID,
  event type, payload, aggregate identity, idempotency identity, correlation,
  explicit causation or null, and occurrence time. Publisher and consumer reject
  incomplete or unsupported envelopes.
- Ledger, Credit Wallet, and Settlement error and utility DTOs are
  service-qualified. Their JSON shapes are unchanged.
- Auth, Game Engine, Ledger, Credit Wallet, and Settlement readiness identify
  their contract version and authority owner.

## Event Ownership

The event catalog gives every active cross-service event name one publisher and
one owner. Outbox event ID is the broker idempotency and message identity.
Correlation follows the originating request/workflow. Causation identifies the
initiating command or event when available and is explicitly null otherwise.

## Safety

This package adds no event type, API, service, database, or business behavior.
It removes ambiguous contract names and fail-open compatibility paths while
preserving endpoint payloads and existing authority orchestration.

`npm run qa:cross-service-contract-integrity` enforces the frozen boundary.
