# Phase 17.1 - Credit Dry-Run Approval Capture

## Purpose

Phase 17.1 captures explicit operator approval that Credit Wallet is ready for the next authority-transfer review step.

This phase records approval only. Credit Wallet remains monolith-authoritative.

## Approval Meaning

The shared dry-run approval endpoint now accepts `domain = CREDIT`:

```http
POST /api/authority/approvals/dry-run
```

Valid payload:

```json
{
  "domain": "CREDIT",
  "justification": "Reviewed Credit shadow evidence and rollback readiness.",
  "acknowledgedWarnings": [
    "Raw evidence is not READY and must remain visible for review.",
    "DRY_RUN_APPROVAL is missing.",
    "PROMOTION_APPROVAL is missing."
  ],
  "correlationId": "operator-selected-correlation-id"
}
```

When valid, the platform records an append-only `DRY_RUN_APPROVAL` for `CREDIT` and emits `authority.credit.dry_run.approved` through the outbox.

## Preconditions

Credit dry-run approval is allowed only when:

- Credit authority is `MONOLITH`.
- Credit comparison mode is `ENABLED`.
- Credit rollback readiness is `READY`.
- Credit promotion decision is `READY_FOR_DRY_RUN_APPROVAL`.
- Justification is non-empty.
- All current promotion-decision warnings are acknowledged.

Settlement must remain `SERVICE` and `CERTIFIED`. Ledger must remain `SERVICE` and `CERTIFIED`.

## Decision Integration

After successful approval, Credit promotion decision advances from:

```text
READY_FOR_DRY_RUN_APPROVAL
```

to:

```text
READY_FOR_PROMOTION_APPROVAL
```

It does not advance to `READY_FOR_CONTROLLED_PROMOTION` and does not promote Credit.

## Limitations

Dry-run approval does not:

- change `CREDIT_AUTHORITY`;
- route Credit Wallet authority to Credit Wallet Service;
- change wallet calculations;
- change balances, credit limits, reservations, exposure, settlement logic, or Ledger logic;
- disable comparison mode;
- disable rollback.

## Audit Trail

Approval records are append-only. Reusing the same `correlationId` returns the existing approval and does not create a duplicate record.

The outbox payload includes:

- `domain`;
- `approvalId`;
- `actorUserId`;
- `correlationId`;
- `createdAt`.

No direct RabbitMQ publishing is used.

## Operator Workflow

Review state:

```bash
npm run ops:credit-authority-readiness
npm run ops:credit-promotion-decision
npm run ops:credit-dry-run-evaluation
```

Capture approval:

```bash
npm run ops:approve-credit-dry-run -- \
  --justification "Reviewed Credit shadow evidence and rollback readiness." \
  --acknowledge-warning "Raw evidence is not READY and must remain visible for review." \
  --acknowledge-warning "DRY_RUN_APPROVAL is missing." \
  --acknowledge-warning "PROMOTION_APPROVAL is missing."
```

Verify:

```bash
npm run qa:credit-dry-run-approval
npm run qa:credit-promotion-decision
```

## Next Phase

Phase 17.2 should capture Credit promotion approval review. It must still avoid authority transfer unless a later controlled promotion phase explicitly executes promotion.
