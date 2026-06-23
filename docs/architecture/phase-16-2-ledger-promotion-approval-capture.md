# Phase 16.2 - Ledger Promotion Approval Capture

## Purpose

Phase 16.2 captures explicit operator approval that Ledger is authorized for controlled promotion readiness.

This phase records approval only. Ledger remains `MONOLITH` and authoritative. Ledger Service does not receive production authority, ledger posting is not rerouted, and financial posting behavior is unchanged.

## Current State

- Settlement authority: `SERVICE`
- Settlement certification: `CERTIFIED`
- Ledger authority: `MONOLITH`
- Ledger comparison mode: `ENABLED`
- Ledger decision before approval: `READY_FOR_PROMOTION_APPROVAL`
- Credit authority: `MONOLITH`

## Approval API

Ledger promotion approval uses the shared authority approval endpoint:

```http
POST /api/authority/approvals/promotion
```

Payload:

```json
{
  "domain": "LEDGER",
  "justification": "Operator reviewed Ledger dry-run evidence and rollback readiness.",
  "acknowledgedWarnings": [
    "Raw evidence is not READY and must remain visible for review.",
    "PROMOTION_APPROVAL is missing."
  ],
  "correlationId": "optional-idempotency-key"
}
```

The endpoint is protected by existing admin authorization. It records an append-only `PROMOTION_APPROVAL` for `LEDGER`.

## Validation Rules

Approval is allowed only when:

- `domain = LEDGER`
- `DRY_RUN_APPROVAL` exists
- Ledger promotion decision is `READY_FOR_PROMOTION_APPROVAL`
- rollback readiness is `READY`
- Ledger authority is `MONOLITH`
- Ledger comparison mode is `ENABLED`
- justification is non-empty
- all current warnings are acknowledged

If a `correlationId` is supplied, repeated requests return the original approval record.

## Decision Transition

Before approval:

```text
READY_FOR_PROMOTION_APPROVAL
```

After approval:

```text
READY_FOR_CONTROLLED_PROMOTION
```

This does not promote Ledger. The decision means all operator approvals required for controlled promotion are present.

## Audit And Outbox

The approval emits an outbox event:

```text
authority.ledger.promotion.approved
```

Payload includes:

- `domain`
- `actorUserId`
- `approvalId`
- `correlationId`
- `createdAt`

No direct RabbitMQ publish occurs.

## Operational Limits

Promotion approval does not:

- change `LEDGER_AUTHORITY`
- make Ledger Service authoritative
- route ledger posting to Ledger Service
- update balances
- change financial posting rules
- disable comparison mode
- remove rollback controls

## Next Phase

Phase 16.3 should implement the Ledger controlled promotion simulation/execution framework, still without performing authority transfer unless explicitly requested by a future phase.
