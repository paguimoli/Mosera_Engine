# Settlement Authority Approval Runbook

## Purpose

This runbook defines the operator review required before a future Settlement authority promotion.

Phase 14.2 does not perform promotion. It only exposes readiness, approval history, and dry-run evaluation.

## Review Commands

```bash
npm run ops:promotion-decision
npm run ops:approve-settlement-dry-run -- \
  --justification "Operator reviewed lifecycle-adjusted evidence and approves dry-run readiness." \
  --acknowledge-warning "Raw evidence is not READY and must remain visible for review."
npm run ops:approve-settlement-promotion -- \
  --justification "Operator reviewed dry-run evidence and approves controlled promotion planning." \
  --acknowledge-warning "Raw evidence is not READY and must remain visible for review." \
  --acknowledge-warning "PROMOTION_APPROVAL is missing."
npm run ops:authority-approval-status
npm run ops:authority-approval-history
npm run ops:settlement-dry-run-evaluation
```

## Promotion Decision Source

Phase 14.4 makes the promotion decision engine the authoritative source for operator promotion readiness.

Operators should use `npm run ops:promotion-decision` first. Raw evidence remains visible, but lifecycle-excluded QA evidence must not block promotion once the promotion decision reports it as excluded.

## Pre-Dry-Run Checklist

1. Confirm `SETTLEMENT_AUTHORITY=MONOLITH`.
2. Confirm `SETTLEMENT_COMPARISON_MODE=ENABLED`.
3. Confirm the promotion decision is `READY_FOR_DRY_RUN_APPROVAL`.
4. Confirm promotion readiness is `READY`.
5. Confirm rollback readiness is `READY`.
6. Review warnings, including raw evidence warnings.
7. Record a `DRY_RUN_APPROVAL` through `npm run ops:approve-settlement-dry-run`.

## Dry-Run Approval Capture

Dry-run approval may only be captured by an authorized operator with administrative permissions.

The approval request must include:

- non-empty justification
- acknowledged warnings
- optional correlation ID for idempotent retry

The raw evidence warning must be acknowledged exactly when present:

`Raw evidence is not READY and must remain visible for review.`

Dry-run approval records are append-only. Operators must not edit or delete approval history.

Capturing dry-run approval does not:

- promote Settlement Service
- change `SETTLEMENT_AUTHORITY`
- route settlements to Settlement Service
- disable monolith settlement
- approve final promotion

## Pre-Promotion Checklist

1. Confirm dry-run evidence has been reviewed.
2. Confirm the promotion decision is `READY_FOR_PROMOTION_APPROVAL` before recording promotion approval.
3. Confirm no unexplained critical mismatch exists.
4. Confirm no unexplained failure exists.
5. Confirm `DRY_RUN_APPROVAL` exists.
6. Record `PROMOTION_APPROVAL` through `npm run ops:approve-settlement-promotion`.
7. Confirm the promotion decision advances to `READY_FOR_CONTROLLED_PROMOTION`.
8. Confirm rollback operator and rollback window are assigned.
9. Keep rollback approval process available.

## Promotion Approval Capture

Promotion approval may only be captured by an authorized operator with administrative permissions.

The approval request must include:

- non-empty justification
- acknowledgement of every current promotion decision warning
- optional correlation ID for idempotent retry

Promotion approval records are append-only. Operators must not edit or delete approval history.

Capturing promotion approval does not:

- promote Settlement Service
- change `SETTLEMENT_AUTHORITY`
- route settlements to Settlement Service
- disable monolith settlement
- complete the authority transfer

After promotion approval, the next state is `READY_FOR_CONTROLLED_PROMOTION`.

## Operator Rules

- Do not promote authority through API.
- Do not edit approval history.
- Do not delete approval history.
- Do not ignore raw readiness blockers.
- Do not treat promotion readiness as automatic promotion approval.
- Do not treat lifecycle exclusion as evidence deletion.
- Do not promote authority outside a future controlled promotion phase.

## Emergency Rollback Review

Rollback approval is required before planned rollback actions. Emergency rollback procedures must still preserve audit records, correlation IDs, and post-incident reconciliation.
