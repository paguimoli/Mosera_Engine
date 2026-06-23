# Phase 16.1 - Ledger Dry-Run Approval Capture

## Purpose

Phase 16.1 records explicit operator approval that Ledger is authorized to proceed from candidate review into dry-run promotion readiness.

This phase records approval only. Ledger remains monolith-authoritative.

## Authority State

| Domain | Required State |
| --- | --- |
| Settlement | `SERVICE`, certified |
| Ledger | `MONOLITH` |
| Ledger Comparison | `ENABLED` |
| Credit | `MONOLITH` |

## Approval Meaning

`DRY_RUN_APPROVAL` for `LEDGER` means an authorized operator has reviewed Ledger shadow evidence, lifecycle-adjusted evidence, rollback readiness, service health, and warnings, and accepts moving Ledger to the next approval stage.

It does not:

- Promote Ledger.
- Route ledger posting to Ledger Service.
- Make Ledger Service authoritative.
- Change ledger posting rules.
- Change balance calculations.
- Disable comparison mode.

## API

`POST /api/authority/approvals/dry-run`

Input:

```json
{
  "domain": "LEDGER",
  "justification": "Operator justification",
  "acknowledgedWarnings": ["..."],
  "correlationId": "optional"
}
```

Validation:

- Authenticated admin is required.
- Ledger promotion decision must be `READY_FOR_DRY_RUN_APPROVAL`.
- Ledger rollback readiness must be `READY`.
- Ledger authority must be `MONOLITH`.
- Ledger comparison mode must be `ENABLED`.
- Justification must be non-empty.
- All current warnings must be acknowledged.

## Audit Event

Approval emits an outbox event:

`authority.ledger.dry_run.approved`

Payload includes:

- `domain`
- `actorUserId`
- `approvalId`
- `correlationId`
- `createdAt`

## Decision Result

After approval, Ledger promotion decision advances to:

`READY_FOR_PROMOTION_APPROVAL`

It must not become `PROMOTED` in this phase.

## Next Step

Phase 16.2 should implement Ledger promotion approval capture. Ledger authority must remain `MONOLITH` until a later controlled promotion execution phase.
