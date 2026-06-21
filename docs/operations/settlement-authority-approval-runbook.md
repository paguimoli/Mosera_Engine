# Settlement Authority Approval Runbook

## Purpose

This runbook defines the operator review required before a future Settlement authority promotion.

Phase 14.2 does not perform promotion. It only exposes readiness, approval history, and dry-run evaluation.

## Review Commands

```bash
npm run ops:promotion-decision
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
7. Record a `DRY_RUN_APPROVAL` through the documented future approval process.

## Pre-Promotion Checklist

1. Confirm dry-run evidence has been reviewed.
2. Confirm the promotion decision is `READY_FOR_PROMOTION_APPROVAL` before recording promotion approval.
3. Confirm no unexplained critical mismatch exists.
4. Confirm no unexplained failure exists.
5. Confirm `PROMOTION_APPROVAL` exists.
6. Confirm rollback operator and rollback window are assigned.
7. Keep rollback approval process available.

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
