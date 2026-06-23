# Phase 16.3 - Ledger Controlled Promotion Execution Framework

## Purpose

Phase 16.3 creates the Ledger controlled promotion execution framework in simulation-only mode.

Ledger remains `MONOLITH` and authoritative. No routing changes occur, Ledger Service does not become authoritative, and financial posting behavior is unchanged.

## Current State

- Settlement authority: `SERVICE`
- Settlement certification: `CERTIFIED`
- Ledger authority: `MONOLITH`
- Ledger comparison mode: `ENABLED`
- Ledger decision: `READY_FOR_CONTROLLED_PROMOTION`
- Ledger `DRY_RUN_APPROVAL`: captured
- Ledger `PROMOTION_APPROVAL`: captured
- Credit authority: `MONOLITH`

## Promotion Simulation API

```http
POST /api/authority/ledger-promotion/simulate
```

Protected by existing admin authorization.

Promotion simulation validates:

- Ledger decision is `READY_FOR_CONTROLLED_PROMOTION`
- rollback readiness is `READY`
- Ledger authority is `MONOLITH`
- Ledger comparison mode is `ENABLED`
- Ledger Service health is available
- dry-run approval exists
- promotion approval exists

The response includes:

- `promotionAllowed`
- `blockers`
- `warnings`
- `currentAuthority`
- `proposedAuthority`
- `simulatedAuthority`
- `rollbackReady`
- `auditEvent`

Simulation does not change authority.

## Rollback Simulation API

```http
POST /api/authority/ledger-rollback/simulate
```

Protected by existing admin authorization.

Rollback simulation validates:

- monolith ledger path is available
- comparison mode is enabled
- authority controls are available
- rollback readiness is `READY`

The response includes:

- `rollbackAllowed`
- `blockers`
- `warnings`
- `authorityState`
- `simulatedAuthority`
- `rollbackReady`
- `auditEvent`

Simulation does not change authority.

## Audit Events

Promotion simulation emits:

```text
authority.ledger.promotion.simulated
```

Rollback simulation emits:

```text
authority.ledger.rollback.simulated
```

Payloads include:

- `domain`
- `actorUserId`
- `correlationId`
- `decision`
- `timestamp`
- blockers and warnings

Events are written through the outbox only. No direct broker publish occurs.

## Operations Commands

```bash
npm run ops:simulate-ledger-promotion
npm run ops:simulate-ledger-rollback
```

These commands are advisory and do not mutate authority state.

## Limitations

This framework does not:

- set `LEDGER_AUTHORITY=SERVICE`
- route ledger posting to Ledger Service
- update balances
- change ledger posting rules
- disable comparison mode
- execute rollback
- modify approvals

## Next Phase

Phase 16.4 should add controlled Ledger authority promotion execution support, with explicit operator controls and rollback preservation.
