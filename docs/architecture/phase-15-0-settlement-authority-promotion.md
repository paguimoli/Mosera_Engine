# Phase 15.0 - Controlled Settlement Authority Promotion

## Purpose

Phase 15.0 performs the first controlled authority transfer for Settlement only.
Settlement moves from `MONOLITH` to `SERVICE` authority while Ledger and Credit
remain `MONOLITH`.

This phase does not change settlement math, ledger math, credit math, accounting,
commission, reconciliation, or authentication behavior.

## Authority State

Before promotion:

| Domain | Authority | Comparison |
| --- | --- | --- |
| Settlement | `MONOLITH` | `ENABLED` |
| Ledger | `MONOLITH` | `ENABLED` |
| Credit | `MONOLITH` | `ENABLED` |

After promotion:

| Domain | Authority | Comparison |
| --- | --- | --- |
| Settlement | `SERVICE` | `ENABLED` |
| Ledger | `MONOLITH` | `ENABLED` |
| Credit | `MONOLITH` | `ENABLED` |

Settlement Service is the controlled authority candidate. The monolith remains
available for comparison and rollback.

## Promotion Preconditions

Promotion is allowed only when:

- Promotion decision is `READY_FOR_CONTROLLED_PROMOTION`.
- Dry-run approval exists.
- Promotion approval exists.
- Rollback readiness is `READY`.
- Current Settlement authority is `MONOLITH`.
- Settlement comparison mode is `ENABLED`.
- Settlement Service health is available.

The promotion execute API reuses the Phase 14.7 promotion simulation checks before
changing authority.

## Promotion Execution

Promotion is performed through:

- `POST /api/authority/promotion/execute`
- `npm run ops:settlement-promote`

The operation sets the runtime Settlement authority to `SERVICE` and keeps
`SETTLEMENT_COMPARISON_MODE=ENABLED`. The operations script also updates local
`.env.local` so local QA restarts preserve the controlled promotion state.

The operation is idempotent. If Settlement is already `SERVICE`, the API reports
the existing promoted state and does not emit a duplicate promotion event.

## Promotion Event

New promotions emit the append-only outbox event:

`authority.promoted`

Payload:

- `domain`
- `previousAuthority`
- `newAuthority`
- `actorUserId`
- `promotionApprovalId`
- `correlationId`
- `promotedAt`

No direct RabbitMQ publishing occurs.

## Runtime Routing

The runtime authority route reports:

- `authoritativePath=SERVICE`
- `comparisonPath=MONOLITH`
- `comparisonMode=ENABLED`
- `productionCutoverActive=true`

This is a control-plane authority transition. The monolith settlement
implementation remains present and available for comparison and rollback.

## Rollback

Rollback remains environment/config driven. A rollback from `SERVICE` to
`MONOLITH` requires:

- Monolith path available.
- Authority controls available.
- Comparison mode available.
- Rollback readiness `READY`.

No schema migration, data restoration, or code removal is required for rollback.

## Validation Checklist

- Settlement authority is `SERVICE`.
- Ledger authority is `MONOLITH`.
- Credit authority is `MONOLITH`.
- Settlement comparison mode is `ENABLED`.
- Rollback readiness is `READY`.
- Promotion status API reports the promotion approval.
- `authority.promoted` exists for the first promotion.
- Shadow reporting remains available.
- Existing credit launch and worker observability QA continue to pass.
