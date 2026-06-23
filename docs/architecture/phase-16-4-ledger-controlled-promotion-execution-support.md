# Phase 16.4 - Ledger Controlled Promotion Execution Support

## Purpose

Phase 16.4 adds controlled Ledger promotion execution support.

This phase creates the explicit execution endpoint and operations commands required to promote Ledger authority in a controlled way. Normal application startup and normal ledger posting behavior are unchanged unless an authenticated operator explicitly runs the execution path.

## Current State Before Execution

- Settlement authority: `SERVICE`
- Settlement certification: `CERTIFIED`
- Ledger authority: `MONOLITH`
- Ledger comparison mode: `ENABLED`
- Ledger decision: `READY_FOR_CONTROLLED_PROMOTION`
- Credit authority: `MONOLITH`

## Promotion Execution API

```http
POST /api/authority/ledger-promotion/execute
```

Payload:

```json
{
  "domain": "LEDGER",
  "mode": "EXECUTE",
  "justification": "Operator reviewed Ledger promotion readiness and rollback readiness.",
  "correlationId": "optional-idempotency-key"
}
```

The endpoint is protected by existing admin authorization.

## Preconditions

Execution requires:

- `domain = LEDGER`
- `mode = EXECUTE`
- non-empty justification
- Ledger decision is `READY_FOR_CONTROLLED_PROMOTION`
- rollback readiness is `READY`
- Ledger authority is `MONOLITH`
- Ledger comparison mode is `ENABLED`
- Ledger Service health is available
- Ledger `DRY_RUN_APPROVAL` exists
- Ledger `PROMOTION_APPROVAL` exists

If Ledger is already `SERVICE`, execution returns an idempotent success response and does not emit a duplicate promotion event.

## Execution Behavior

When valid, execution:

- updates runtime Ledger authority to `SERVICE`;
- keeps Ledger comparison mode `ENABLED`;
- keeps Settlement `SERVICE`;
- keeps Credit `MONOLITH`;
- emits `authority.ledger.promoted`;
- records actor, justification, approval id, correlation id, and timestamp.

The endpoint does not change ledger posting calculations, balances, settlement logic, credit logic, or wallet behavior.

## Promotion Status API

```http
GET /api/authority/ledger-promotion-status
```

Returns:

- `domain`
- `authority`
- `comparisonMode`
- `promotedAt`
- `rollbackReady`
- `rollbackReadiness`
- `promotionApprovalId`
- `evaluatedAt`

## Operations Commands

Promotion:

```bash
npm run ops:ledger-promote -- \
  --justification "Reviewed Ledger controlled promotion readiness." \
  --correlation-id "operator-selected-correlation-id"
```

Status:

```bash
npm run ops:ledger-promotion-status
```

The promotion operations script persists:

```text
LEDGER_AUTHORITY=SERVICE
LEDGER_COMPARISON_MODE=ENABLED
```

to `.env.local`, matching the existing Settlement promotion pattern. `.env.local` is local runtime configuration and is not committed.

## Rollback Sequence

Rollback execution is not added in this phase. The rollback-ready state remains visible through:

```bash
npm run ops:rollback-readiness
npm run ops:simulate-ledger-rollback
```

Future rollback execution should switch Ledger authority back to `MONOLITH`, keep comparison controls intact, and emit an append-only rollback event.

## Validation Checklist

- Ledger authority can be promoted only through explicit `EXECUTE` mode.
- Missing justification is rejected.
- Invalid mode is rejected.
- Promotion is idempotent after Ledger is already `SERVICE`.
- Ledger comparison remains `ENABLED`.
- Settlement remains `SERVICE` and `CERTIFIED`.
- Credit remains `MONOLITH`.
- Rollback readiness remains `READY`.
- Existing financial behavior is unchanged.

## Post-Promotion Monitoring

After execution, operators should monitor:

- Ledger promotion status
- rollback readiness
- Ledger shadow reporting
- worker observability
- credit launch QA
- outbox dispatch health

Ledger post-promotion monitoring and rollback drill support should be expanded in Phase 16.5.
