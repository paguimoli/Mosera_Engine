# Settlement Service

Shadow-mode .NET service for future Settlement Service extraction.

## Status

This service is non-authoritative. It must not update tickets, release credit exposure, post ledger entries, update balances, or emit production financial outbox events.

## Endpoints

- `GET /health`
- `GET /health/live`
- `GET /health/ready`
- `POST /v1/settlement/shadow/execute`

## Environment

- `SERVICE_NAME`
- `ASPNETCORE_ENVIRONMENT`
- `RABBITMQ_URL`
- `RABBITMQ_EXCHANGE_NAME`
- `REDIS_URL`

## Shadow Execution

The shadow endpoint calculates a deterministic settlement result and optionally compares it with a monolith result supplied in the request. Money fields are integer minor units only.

Comparison statuses:

- `MATCH`
- `MISMATCH`
- `NOT_COMPARED`

## Validation

```bash
dotnet build services/settlement-service
docker compose up -d --build
curl http://localhost:5400/health
curl http://localhost:5400/health/ready
```

## Rule

No production settlement ownership lives here yet. The monolith remains the source of truth.
