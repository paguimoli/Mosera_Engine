# Ledger Service Skeleton

This service is the Phase 11.9 Ledger Service skeleton. It exposes the Ledger contract surface from Phase 11.8, but it does not yet own production ledger posting.

## Purpose

The future Ledger Service will own the financial ledger posting interface, reversal interface, query interface, audit trail, and ledger event publication. In this phase it is a non-production shell only.

Production financial behavior remains in the existing Next.js/Supabase monolith and hardened database RPCs.

## Non-production status

This service must not be routed production traffic yet. It does not call `post_financial_ledger_entry`, does not call `reverse_financial_ledger_entry`, does not publish ledger events, and does not calculate balances.

## Endpoints

- `GET /health`
- `GET /health/live`
- `GET /health/ready`
- `POST /v1/ledger/entries`
- `POST /v1/ledger/entries/{ledgerEntryId}/reverse`
- `GET /v1/ledger/entries/{ledgerEntryId}`
- `GET /v1/ledger/accounts/{accountId}/entries`
- `GET /v1/ledger/health`

Ledger command and query endpoints currently return safe placeholder `LEDGER_NOT_IMPLEMENTED` responses after basic contract validation.

## Required environment variables

- `SERVICE_NAME`
- `ASPNETCORE_ENVIRONMENT`
- `RABBITMQ_URL`
- `RABBITMQ_EXCHANGE_NAME`
- `REDIS_URL`

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
git diff --check
```

## Production ownership rule

Ledger Service does not yet own production ledger posting. It must not replace the existing hardened RPC posting path until contracts, reconciliation, feature-flag routing, shadow validation, rollback, and operational monitoring are proven.
