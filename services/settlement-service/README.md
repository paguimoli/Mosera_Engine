# Settlement Service

The .NET Settlement Service owns the canonical settlement decision candidate,
durable financial instruction intent, recovery, reconciliation, reversal, and
resettlement orchestration.

Production authority is not active. The default remains
`SETTLEMENT_AUTHORITY=MONOLITH`; SERVICE activation fails closed.

## Canonical Boundary

The service consumes immutable SettlementInput evidence derived from a Math
Evaluation Certificate. Tenant and brand assertions are verified against the
canonical Credit Wallet reservation scope before ingestion. It atomically
persists:

- The deterministic SettlementRecord.
- Ledger and Credit Wallet instruction intent.
- Execution evidence.
- A `settlement.decision.recorded` outbox event.

Settlement calls Ledger Service and Credit Wallet Service through their
idempotent APIs. It does not mutate Ledger, wallet, cashier, tax, commission, or
accounting state directly.

## Primary Endpoints

- `GET /health/live`
- `GET /health/ready`
- `GET /v1/settlement/authority/readiness`
- `POST /v1/settlement/inputs/ingest`
- `POST /v1/settlement/requests/{id}/execute`
- `POST /v1/settlement/requests/{id}/replay`
- `POST /v1/settlement/records/{id}/financial-instructions/execute`
- `POST /v1/settlement/records/{id}/recover`
- `POST /v1/settlement/resettlement-chains`

Legacy run-based and shadow endpoints remain compatibility/dry-run surfaces
only. They are not a fallback for the canonical path.

## Required Runtime Configuration

- `DATABASE_URL`
- `LEDGER_SERVICE_URL`
- `CREDIT_SERVICE_URL`
- `CREDIT_WALLET_INTERNAL_API_KEY`
- `RABBITMQ_URL`
- `REDIS_URL`
- `SETTLEMENT_AUTHORITY`
- `SETTLEMENT_LEGACY_MUTATIONS_ENABLED` (`false` in production)

Readiness requires durable settlement migrations, outbox persistence, and all
critical dependencies. SERVICE mode remains blocked even when operational
readiness passes. Production startup fails if legacy mutation routes are
enabled.

Historical settlement evidence is never deleted. Append-only classifications
may exclude only proven development, dry-run, synthetic QA, or superseded
evidence from promotion evaluation; unknown and production-shaped evidence
remain blocking.

See `docs/architecture/service-contract-settlement.md` for lifecycle, authority
routing, recovery, promotion, rollback, and remaining blockers.
