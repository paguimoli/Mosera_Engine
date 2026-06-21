# Authority Transfer Runbook

## Purpose

This runbook defines the controlled process for future Settlement, Ledger, and Credit authority transfer. Phase 13.9 only creates the controls; it does not perform a transfer.

## Pre-Transfer Checklist

- Shadow readiness endpoint reports `READY` for the target domain.
- Rollback readiness endpoint reports `READY`.
- Comparison mode is `ENABLED`.
- Mismatch and failure rates are below thresholds.
- Reconciliation has no unresolved launch-blocking findings.
- Operators have reviewed service health and logs.
- Rollback owner is assigned.

## Authority Status

Run:

```bash
npm run ops:authority-status
```

The command reports current authority, comparison mode, mismatch threshold, and service URL for Settlement, Ledger, and Credit.

## Rollback Readiness

Run:

```bash
npm run ops:rollback-readiness
```

The command reports monolith availability, service health, comparison status, and rollback readiness.

## Transfer Procedure

1. Select one domain only.
2. Verify shadow readiness and rollback readiness.
3. Update the domain authority environment variable from `MONOLITH` to `SERVICE`.
4. Keep comparison mode `ENABLED`.
5. Deploy through the normal release process.
6. Monitor health, mismatch reporting, reconciliation, and support signals.

## Rollback Procedure

1. Set the domain authority environment variable back to `MONOLITH`.
2. Redeploy or restart the runtime.
3. Confirm app health and monolith execution path.
4. Run shadow readiness and reconciliation.
5. File a rollback report with correlation IDs and mismatch evidence.

## Emergency Rules

- Do not manually edit financial records.
- Do not disable authentication or MFA.
- Do not bypass outbox.
- Do not silence comparison evidence.
- Do not run multiple authority transfers at once.

## Environment Variables

```text
SETTLEMENT_AUTHORITY=MONOLITH
LEDGER_AUTHORITY=MONOLITH
CREDIT_AUTHORITY=MONOLITH

SETTLEMENT_COMPARISON_MODE=ENABLED
LEDGER_COMPARISON_MODE=ENABLED
CREDIT_COMPARISON_MODE=ENABLED

SETTLEMENT_MISMATCH_ALERT_THRESHOLD=0.001
LEDGER_MISMATCH_ALERT_THRESHOLD=0.001
CREDIT_MISMATCH_ALERT_THRESHOLD=0.001
```
