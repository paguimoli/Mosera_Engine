# Ledger Service

This service exposes the Ledger contract surface, guarded durable posting endpoints, and the Phase 13.5 shadow-mode execution endpoint. It does not own production ledger authority by default.

## Purpose

The Ledger Service owns the service-side financial ledger posting interface, reversal interface, query interface, and audit trail capability while authority routing remains guarded. It can also independently validate ledger posting payloads in shadow mode and persist shadow evidence for operational review.

Production financial behavior remains in the existing Next.js/Supabase monolith and hardened database RPCs.

## Non-production status

This service must not be routed production authority unless the authority guardrails pass. Its posting and reversal endpoints call the hardened `post_financial_ledger_entry` path with canonical request hashing and conflict-safe idempotency, but Compose defaults remain MONOLITH and production authority is not enabled.

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

Ledger command and query endpoints validate canonical posting contracts, enforce currency/account/idempotency rules, and use the durable ledger RPC path when DATABASE_URL is configured.

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

This phase validates header presence and binds it to a canonical request hash. Duplicate idempotency keys with the same canonical request return the existing ledger entry; conflicting canonical requests fail closed.

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

`GET /health/ready` validates required dependencies and reports durable ledger capability markers when DATABASE_URL is configured. The Ledger-specific health endpoint includes canonical posting, hash validation, conflict-safe idempotency, and currency/account validation readiness.

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

Ledger Service does not become production ledger authority by default. It must not replace the existing MONOLITH routing path unless contracts, guardrails, reconciliation, feature-flag routing, shadow validation, rollback, and operational monitoring are proven.
