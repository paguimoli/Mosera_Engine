# Settlement Controlled Promotion Runbook

## Purpose

This runbook describes the operator checklist for simulating and executing controlled Settlement authority promotion and rollback.

Phase 15.0 executes Settlement authority promotion only. Ledger and Credit remain `MONOLITH`.

## Preconditions

Before simulation or promotion:

1. Confirm `SETTLEMENT_AUTHORITY=MONOLITH`.
2. Confirm `SETTLEMENT_COMPARISON_MODE=ENABLED`.
3. Confirm promotion decision is `READY_FOR_CONTROLLED_PROMOTION`.
4. Confirm `DRY_RUN_APPROVAL` exists.
5. Confirm `PROMOTION_APPROVAL` exists.
6. Confirm rollback readiness is `READY`.
7. Confirm Settlement Service health is available.

## Promotion Simulation

Run:

```bash
npm run ops:simulate-settlement-promotion
```

Expected:

- `promotionAllowed=true`
- no blockers
- authority remains `MONOLITH`
- comparison remains `ENABLED`
- outbox event `authority.promotion.simulated` exists

## Controlled Promotion

Run:

```bash
npm run ops:settlement-promote
```

Expected:

- Settlement authority becomes `SERVICE`
- Settlement comparison remains `ENABLED`
- Ledger authority remains `MONOLITH`
- Credit authority remains `MONOLITH`
- rollback readiness remains `READY`
- outbox event `authority.promoted` exists for the first promotion
- local `.env.local` contains `SETTLEMENT_AUTHORITY=SERVICE`
- local `.env.local` contains `SETTLEMENT_COMPARISON_MODE=ENABLED`

The command is idempotent. Re-running it while Settlement is already `SERVICE`
must not emit duplicate promotion events.

## Promotion Status

Run:

```bash
npm run ops:settlement-promotion-status
```

Expected:

- `authority=SERVICE`
- `comparisonMode=ENABLED`
- `rollbackReady=true`
- `promotionApprovalId` is present

## Post-Promotion Monitoring

Run:

```bash
npm run ops:settlement-post-promotion-status
```

Expected:

- `authority=SERVICE`
- `comparisonMode=ENABLED`
- `serviceHealth.available=true`
- `rollbackReadiness=READY`
- post-promotion mismatch and failure counts are reviewed
- recommendation is recorded in the release evidence package

## Rollback Trigger Analysis

Run:

```bash
npm run ops:rollback-trigger-analysis
```

Expected:

- `triggerSource=POST_PROMOTION_EVIDENCE` while Settlement authority is `SERVICE`
- raw evidence remains visible
- lifecycle-excluded QA evidence is reported in excluded counts
- promotion evidence is `READY`
- post-promotion evidence is reviewed
- rollback does not trigger solely because of excluded QA evidence

Rollback trigger hierarchy:

1. Post-promotion evidence
2. Promotion lifecycle evidence
3. Raw evidence for audit visibility only

Raw evidence must never be deleted to make trigger state look clean.

## Stabilization Window

Run:

```bash
npm run ops:settlement-stabilization-status -- --window 7d
```

Supported windows:

- `24h`
- `7d`
- `30d`
- `all`

Expected:

- Settlement authority remains `SERVICE`
- comparison mode remains `ENABLED`
- rollback readiness remains `READY`
- stabilization status is recorded
- post-promotion metrics are reviewed

Stabilization statuses:

- `STABILIZING`: evidence is still accumulating.
- `STABLE`: service authority is healthy and no active rollback condition exists.
- `REVIEW_REQUIRED`: warning-level conditions require operator review.
- `ROLLBACK_RECOMMENDED`: rollback trigger or critical parity failures are active.

Exit the stabilization window only after sustained `STABLE` status over the agreed monitoring period.

## Rollback Simulation

Run:

```bash
npm run ops:simulate-settlement-rollback
```

Expected:

- `rollbackAllowed=true`
- no blockers
- monolith path available
- rollback readiness `READY`
- outbox event `authority.rollback.simulated` exists

## Rollback Drill

Run:

```bash
npm run ops:simulate-settlement-rollback-drill
```

Expected:

- `drillPassed=true`
- `authorityBefore=SERVICE`
- `authorityAfter=SERVICE`
- `authorityChanged=false`
- `comparisonMode=ENABLED`
- outbox event `authority.rollback.drill.simulated` exists

The rollback drill is simulation-only. It must not change authority.

## Operator Checklist

1. Run promotion simulation.
2. Run rollback simulation.
3. Review blockers and warnings.
4. Run controlled promotion.
5. Verify promotion status.
6. Verify Settlement authority is `SERVICE`.
7. Verify Ledger and Credit authority remain `MONOLITH`.
8. Verify comparison remains `ENABLED`.
9. Verify rollback readiness remains `READY`.
10. Run post-promotion monitoring.
11. Run rollback drill.
12. Run rollback trigger analysis.
13. Run stabilization status.
14. Verify post-promotion QA.
15. Record results in the release evidence package.

## Emergency Rollback Procedure

Rollback must preserve:

- approval history
- promotion simulation evidence
- rollback simulation evidence
- outbox audit events
- post-action reconciliation

Emergency rollback must return authority to `MONOLITH`, keep comparison available where possible, and run reconciliation after the rollback. Rollback must not require schema migration, data restoration, or code removal.

## Hard Operator Rules

- Do not manually edit approval history.
- Do not delete simulation events.
- Do not change `SETTLEMENT_AUTHORITY` outside the approved promotion or rollback process.
- Do not disable monolith settlement.
- Do not remove rollback controls.
- Do not promote Ledger.
- Do not promote Credit.
