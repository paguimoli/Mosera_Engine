# Phase 14.6 - Promotion Approval Capture

## Purpose

Phase 14.6 captures explicit operator approval that Settlement is authorized for a future controlled promotion.

This phase records approval only.

It does not:

- promote Settlement Service
- change `SETTLEMENT_AUTHORITY`
- route settlement execution to Settlement Service
- disable monolith settlement
- change financial calculations
- change readiness thresholds

## Approval Meaning

`PROMOTION_APPROVAL` means an authorized operator has reviewed dry-run readiness, rollback readiness, warning acknowledgements, and promotion evidence, and approves planning a controlled promotion in a future phase.

After capture, the promotion decision advances from:

`READY_FOR_PROMOTION_APPROVAL`

to:

`READY_FOR_CONTROLLED_PROMOTION`

The service is not promoted by this approval.

## API

`POST /api/authority/approvals/promotion`

Request:

```json
{
  "domain": "SETTLEMENT",
  "justification": "Operator reviewed dry-run readiness and approves controlled promotion planning.",
  "acknowledgedWarnings": [
    "Raw evidence is not READY and must remain visible for review.",
    "PROMOTION_APPROVAL is missing."
  ],
  "correlationId": "optional-correlation-id"
}
```

The endpoint requires existing administrative authorization.

## Validation Rules

Approval is rejected unless:

- domain is `SETTLEMENT`
- promotion decision is `READY_FOR_PROMOTION_APPROVAL`
- `DRY_RUN_APPROVAL` exists
- rollback readiness is `READY`
- current authority is `MONOLITH`
- comparison mode is `ENABLED`
- justification is non-empty
- all current promotion decision warnings are acknowledged

## Idempotency

If `correlationId` is supplied and a matching Settlement `PROMOTION_APPROVAL` already exists, the endpoint returns the existing approval record.

The repeated request does not create a new approval row or outbox event.

## Audit And Outbox

Approval records are append-only in `authority_approval_records`.

The operation emits the outbox event:

`authority.promotion.approved`

Payload:

- domain
- actorUserId
- approvalId
- correlationId
- createdAt

The event is stored through the outbox pattern. There is no direct RabbitMQ publishing.

## Operations Command

```bash
npm run ops:approve-settlement-promotion -- \
  --justification "Operator reviewed dry-run evidence and approves controlled promotion planning." \
  --acknowledge-warning "Raw evidence is not READY and must remain visible for review." \
  --acknowledge-warning "PROMOTION_APPROVAL is missing." \
  --correlation-id "ops-settlement-promotion-approval-001"
```

## Next Step

After `PROMOTION_APPROVAL`, the system may report `READY_FOR_CONTROLLED_PROMOTION`.

A future controlled promotion phase must still perform the actual authority change. This phase does not perform it.

