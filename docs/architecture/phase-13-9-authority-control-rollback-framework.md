# Phase 13.9 - Authority Control & Rollback Framework

## Purpose

Phase 13.9 creates the operational control plane required for future authority transfer of Settlement, Ledger, and Credit Wallet services. It does not transfer authority, route production traffic to services, or change financial behavior.

## Authority Model

Each extracted-service candidate has one authority value:

- `MONOLITH`: the current TypeScript monolith remains authoritative.
- `SERVICE`: reserved for a future cutover where the extracted service becomes authoritative.

Supported domains:

- `SETTLEMENT`
- `LEDGER`
- `CREDIT`

The default for every domain is `MONOLITH`.

## Comparison Mode

Each domain has a comparison mode:

- `ENABLED`: shadow/comparison evidence should continue to be collected.
- `DISABLED`: comparison is not active and rollback readiness is degraded.

The default for every domain is `ENABLED`.

## Environment Controls

Authority is environment-driven only. There are no mutation APIs and no runtime switching endpoints.

```text
SETTLEMENT_AUTHORITY=MONOLITH
LEDGER_AUTHORITY=MONOLITH
CREDIT_AUTHORITY=MONOLITH

SETTLEMENT_COMPARISON_MODE=ENABLED
LEDGER_COMPARISON_MODE=ENABLED
CREDIT_COMPARISON_MODE=ENABLED

SETTLEMENT_MISMATCH_ALERT_THRESHOLD=0.001
LEDGER_MISMATCH_ALERT_THRESHOLD=0.001
CREDIT_MISMATCH_ALERT_THRESHOLD=0.001
```

Invalid or missing authority values resolve to `MONOLITH`. Invalid or missing comparison values resolve to `ENABLED`.

## Runtime Resolution

Future cutovers must use the centralized helpers:

- `resolveSettlementAuthority()`
- `resolveLedgerAuthority()`
- `resolveCreditAuthority()`

Future comparison checks must use the centralized comparison helpers rather than hardcoded environment reads.

## Rollback Readiness Model

Rollback readiness is advisory. It checks:

- monolith path availability
- configured service health
- comparison mode
- authority status

Status values:

- `READY`: authority settings, comparison mode, and health checks are acceptable.
- `WARNING`: future-service health or comparison evidence is degraded while monolith remains available.
- `BLOCKED`: the authoritative service is configured as `SERVICE` but unavailable, or the monolith path is unavailable.

## Operational APIs

- `GET /api/authority/status`
- `GET /api/authority/rollback-readiness`

Both endpoints are protected by `system.admin` permission.

## Cutover Process

1. Confirm shadow readiness is `READY` for the domain over the required review window.
2. Confirm mismatch and failure rates are below thresholds.
3. Confirm rollback readiness is `READY`.
4. Confirm service health and operational runbooks.
5. Change the relevant authority environment variable in a controlled deployment.
6. Keep comparison mode enabled after cutover.
7. Monitor shadow/readiness evidence continuously.

No cutover is performed in this phase.

## Rollback Process

1. Change the affected authority environment variable back to `MONOLITH`.
2. Redeploy or restart the runtime using the restored environment.
3. Keep comparison mode enabled.
4. Run reconciliation and shadow readiness checks.
5. Produce an incident and reconciliation report.

## Emergency Procedure

If a service cutover causes degraded or unsafe behavior:

1. Stop the rollout.
2. Restore authority to `MONOLITH`.
3. Verify app health, service health, RabbitMQ, Redis, and reconciliation.
4. Review mismatch/failure evidence.
5. Do not repair financial state automatically.

## Non-Goals

- No authority transfer.
- No production traffic routing change.
- No financial calculation change.
- No service mutation API.
- No automatic rollback.
