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
10. Verify post-promotion QA.
11. Record results in the release evidence package.

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
