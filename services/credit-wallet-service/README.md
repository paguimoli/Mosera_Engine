# Credit Wallet Service

This service exposes the Credit Wallet contract surface, durable read-only wallet views, and the Phase 13.6 shadow-mode execution endpoints. It does not own production credit operations.

## Purpose

The future Credit Wallet Service will own credit limits, available credit, pending exposure, exposure reservation, exposure release, settlement application, credit adjustments, and credit wallet query interfaces. In this phase it can read durable local credit wallet state and independently validate credit reservation, release, and settlement-credit calculations in shadow mode.

Production credit behavior remains in the existing platform until contracts, reconciliation, feature flags, rollback, and operational monitoring are proven.

## Non-production status

This service does not implement full production credit authority, allocation logic, event consuming, or production routing. Durable reserve/release/settle/reconciliation endpoints are enabled only as a scoped capability while `CREDIT_AUTHORITY` remains `MONOLITH`. Durable read endpoints do not modify rows. Shadow mode never updates production balances, reservations, exposure, available credit, or outbox events.

## Supported endpoints

- `GET /health`
- `GET /health/live`
- `GET /health/ready`
- `GET /v1/credit-wallets/health`
- `POST /v1/credit-wallets/{playerId}/limit`
- `POST /v1/credit-wallets/{agentId}/allocate`
- `POST /v1/credit-wallets/{allocationId}/reallocate`
- `POST /v1/credit-wallets/{playerId}/reserve`
- `POST /v1/credit-wallets/{playerId}/release`
- `POST /v1/credit-wallets/{playerId}/settle`
- `POST /v1/credit-wallets/{playerId}/adjust`
- `GET /v1/credit-wallets/{playerId}`
- `GET /v1/credit-wallets/{playerId}/transactions`
- `GET /v1/credit-wallets/{playerId}/exposure`
- `GET /v1/credit-wallets/{playerId}/summary`
- `POST /v1/credit/shadow/reserve`
- `POST /v1/credit/shadow/release`
- `POST /v1/credit/shadow/settlement`

Credit reserve/release command endpoints use durable Postgres RPCs when `DATABASE_URL` is configured. Duplicate reserve/release idempotency keys return the original durable reservation state. Other credit command endpoints currently return safe placeholder `CREDIT_NOT_IMPLEMENTED` responses after basic contract validation. Query endpoints read durable Postgres state when `DATABASE_URL` is configured; otherwise they keep the safe placeholder behavior.

Shadow endpoints validate and compare credit calculations against an optional monolith result. They may persist shadow evidence only.

## Money standard

All monetary amounts use integer minor currency units.

```json
{
  "amount": 1050,
  "currency": "USD"
}
```

Floating point monetary values are prohibited. Credit Wallet contracts do not expose `decimal`, `float`, or `double` money amount fields.

## Correlation IDs

The service accepts `x-correlation-id` when provided and generates one when missing. Every response includes `x-correlation-id`, and structured logs include service name and correlation ID where practical.

## Idempotency

Balance-impacting command endpoints require `Idempotency-Key`:

- Limit changes.
- Allocation.
- Reallocation.
- Reservation.
- Release.
- Settlement.
- Adjustment.

Reserve and release use durable idempotency storage. Other command endpoints validate header presence only and remain placeholders.

## Launch model

Launch model: North American.

Supported models:

- North American.
- Asian Credit.

## Required environment variables

- `SERVICE_NAME`
- `ASPNETCORE_ENVIRONMENT`
- `RABBITMQ_URL`
- `RABBITMQ_EXCHANGE_NAME`
- `REDIS_URL`
- `DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Inside Docker Compose:

- `RABBITMQ_URL=amqp://lottery:lottery_dev_password@rabbitmq:5672`
- `REDIS_URL=redis://redis:6379`

## Readiness checks

`GET /health/ready` validates RabbitMQ TCP connectivity and Redis PING connectivity. The Credit Wallet-specific health endpoint reports database and Ledger Service as `not_configured` because this skeleton does not connect to production credit storage or Ledger Service yet.
When `DATABASE_URL` is configured, `GET /health/ready` also validates Postgres connectivity. The Credit Wallet-specific health endpoint reports durable read capability and scoped reserve/release/settle/reconciliation mutation/idempotency capability. This is not full production authority.

## Shadow persistence

Shadow persistence writes only to:

- `credit_shadow_runs`
- `credit_shadow_mismatches`
- `credit_shadow_failures`

The migration `20260619000200_create_credit_shadow_reporting.sql` must be applied before persisted shadow reporting can pass QA.

Mismatch categories:

- `AVAILABLE_CREDIT_MISMATCH`
- `RESERVATION_AMOUNT_MISMATCH`
- `EXPOSURE_MISMATCH`
- `SETTLEMENT_CREDIT_MISMATCH`
- `CURRENCY_MISMATCH`
- `UNKNOWN_MISMATCH`

## Validation commands

```bash
dotnet build services/credit-wallet-service
docker compose config
docker compose up -d --build
docker compose ps
curl http://localhost:5300/health
curl http://localhost:5300/health/live
curl http://localhost:5300/health/ready
curl http://localhost:5300/v1/credit-wallets/health
npm run qa:credit-shadow
npm run qa:credit-shadow-reporting
git diff --check
```

## Production ownership rule

Credit Wallet Service does not yet own production credit operations. It must not replace existing monolith functionality until contracts, reconciliation, feature-flag routing, shadow validation, rollback, and operational monitoring are proven.
