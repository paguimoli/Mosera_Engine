# Ledger Service

This service exposes the Ledger contract surface and the Phase 13.5 shadow-mode execution endpoint. It does not own production ledger posting.

## Purpose

The future Ledger Service will own the financial ledger posting interface, reversal interface, query interface, audit trail, and ledger event publication. In this phase it can independently validate ledger posting payloads in shadow mode and persist shadow evidence for operational review.

Production financial behavior remains in the existing Next.js/Supabase monolith and hardened database RPCs.

## Non-production status

This service must not be routed production authority yet. It does not call `post_financial_ledger_entry`, does not call `reverse_financial_ledger_entry`, does not publish ledger events, does not update wallet balances, and does not calculate authoritative balances.

## Endpoints

- `GET /health`
- `GET /health/live`
- `GET /health/ready`
- `POST /v1/ledger/entries`
- `POST /v1/ledger/entries/{ledgerEntryId}/reverse`
- `GET /v1/ledger/entries/{ledgerEntryId}`
- `GET /v1/ledger/accounts/{accountId}/entries`
- `GET /v1/ledger/health`
- `POST /v1/ledger/shadow/execute`

Ledger command and query endpoints currently return safe placeholder `LEDGER_NOT_IMPLEMENTED` responses after basic contract validation.

`POST /v1/ledger/shadow/execute` validates and compares a ledger posting payload against an optional monolith result. It may persist shadow runs, mismatches, and failures, but it never changes production financial state.

## Required environment variables

- `SERVICE_NAME`
- `ASPNETCORE_ENVIRONMENT`
- `RABBITMQ_URL`
- `RABBITMQ_EXCHANGE_NAME`
- `REDIS_URL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Inside Docker Compose:

- `RABBITMQ_URL=amqp://lottery:lottery_dev_password@rabbitmq:5672`
- `REDIS_URL=redis://redis:6379`

## Monetary standard

All monetary amounts use integer minor currency units.

```json
{
  "amount": 1050,
  "currency": "USD"
}
```

Floating point monetary values are prohibited. Ledger contracts do not expose `decimal`, `float`, or `double` money amount fields.

## Idempotency

Command endpoints require the `Idempotency-Key` header:

- `POST /v1/ledger/entries`
- `POST /v1/ledger/entries/{ledgerEntryId}/reverse`

This phase validates header presence only. Durable idempotency storage is not implemented in this service skeleton.

## Correlation IDs

The service accepts `x-correlation-id` when provided and generates one when missing. Every response includes `x-correlation-id`, and structured logs include the service name and correlation ID where practical.

## Shadow persistence

Shadow persistence writes only to:

- `ledger_shadow_runs`
- `ledger_shadow_mismatches`
- `ledger_shadow_failures`

The migration `20260619000100_create_ledger_shadow_reporting.sql` must be applied before persisted shadow reporting can pass QA.

Mismatch categories:

- `AMOUNT_MISMATCH`
- `CURRENCY_MISMATCH`
- `ENTRY_TYPE_MISMATCH`
- `ACCOUNT_MISMATCH`
- `IDEMPOTENCY_MISMATCH`
- `UNKNOWN_MISMATCH`

## Readiness checks

`GET /health/ready` validates RabbitMQ TCP connectivity and Redis PING connectivity. The Ledger-specific health endpoint reports database as `not_configured` because this skeleton does not connect to the production ledger database yet.

## Validation commands

```bash
dotnet build services/ledger-service
docker compose config
docker compose up -d --build
docker compose ps
curl http://localhost:5200/health
curl http://localhost:5200/health/live
curl http://localhost:5200/health/ready
curl http://localhost:5200/v1/ledger/health
npm run qa:ledger-shadow
npm run qa:ledger-shadow-reporting
git diff --check
```

## Production ownership rule

Ledger Service does not yet own production ledger posting. It must not replace the existing hardened RPC posting path until contracts, reconciliation, feature-flag routing, shadow validation, rollback, and operational monitoring are proven.
