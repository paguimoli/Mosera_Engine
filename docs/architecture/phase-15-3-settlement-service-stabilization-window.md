# Phase 15.3 - Settlement Service Stabilization Window

## Purpose

Settlement Service is authoritative while Ledger and Credit remain monolith-owned. This phase adds a read-only stabilization view that lets operators evaluate whether Settlement Service is staying healthy during the post-promotion window.

No authority changes occur in this phase.

## Current Authority Model

- Settlement authority: `SERVICE`
- Settlement comparison mode: `ENABLED`
- Ledger authority: `MONOLITH`
- Credit authority: `MONOLITH`
- Monolith settlement remains available for comparison and rollback.

## Stabilization Inputs

The stabilization service uses existing operational sources:

- Settlement post-promotion monitoring
- Settlement shadow reporting
- Promotion status
- Rollback readiness
- Settlement Service health

Rollback trigger calculations are not duplicated. The stabilization service consumes the post-promotion rollback trigger and evidence summaries.

## Windows

Supported windows:

- `24h`
- `7d`
- `30d`
- `all`

The effective evidence window never starts before the promotion timestamp. For bounded windows, the service uses the later of the promotion timestamp and the requested window start.

## Status Definitions

`STABILIZING`

The service is still collecting post-promotion evidence.

`STABLE`

- Settlement authority is `SERVICE`
- comparison mode is `ENABLED`
- Settlement Service health is available
- rollback readiness is `READY`
- rollback trigger is inactive
- no critical mismatches are present in the effective stabilization window

`REVIEW_REQUIRED`

Warnings are present, service health is degraded, rollback readiness is not ready, or authority/comparison controls are not in the expected post-promotion shape.

`ROLLBACK_RECOMMENDED`

The aligned rollback trigger is active or critical parity failures are detected in lifecycle-effective stabilization evidence.

## Operator Actions

For `STABLE`, continue monitoring until the exit criteria are met.

For `REVIEW_REQUIRED`, review evidence and keep comparison mode enabled.

For `ROLLBACK_RECOMMENDED`, follow the rollback procedure and do not disable comparison mode.

## Stabilization Exit Criteria

Settlement can exit the stabilization window only after operators confirm:

- sustained `STABLE` status across the agreed window
- no active rollback trigger
- rollback readiness remains `READY`
- post-promotion evidence remains ready
- Ledger and Credit remain monolith-owned unless separately promoted

## Validation

Use:

```bash
npm run ops:settlement-stabilization-status -- --window 7d
npm run qa:settlement-stabilization
```

Expected:

- protected API requires authentication
- Settlement authority remains `SERVICE`
- comparison mode remains `ENABLED`
- rollback readiness is reported
- stabilization status and metrics are generated
