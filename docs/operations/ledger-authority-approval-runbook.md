# Ledger Authority Approval Runbook

## Purpose

This runbook describes how operators review and record Ledger authority approvals.

Ledger approval workflows are append-only and auditable. They do not change authority by themselves.

## Current Phase

Phase 16.3 supports Ledger dry-run approval capture, promotion approval capture, and simulation-only controlled promotion/rollback evaluation.

## Preconditions

Before recording Ledger dry-run approval, confirm:

- Ledger authority is `MONOLITH`.
- Ledger comparison mode is `ENABLED`.
- Ledger rollback readiness is `READY`.
- Ledger promotion decision is `READY_FOR_DRY_RUN_APPROVAL`.
- Ledger promotion evidence is `READY`.
- Raw evidence warnings have been reviewed.

Before recording Ledger promotion approval, also confirm:

- Ledger `DRY_RUN_APPROVAL` exists.
- Ledger promotion decision is `READY_FOR_PROMOTION_APPROVAL`.
- Ledger authority is still `MONOLITH`.
- Ledger comparison mode is still `ENABLED`.
- Rollback readiness is still `READY`.

## Review Commands

```bash
npm run ops:ledger-authority-readiness
npm run ops:ledger-promotion-decision
npm run ops:ledger-dry-run-evaluation
```

## Dry-Run Approval Command

```bash
npm run ops:approve-ledger-dry-run -- \
  --justification "Reviewed Ledger shadow evidence and rollback readiness." \
  --acknowledge-warning "Raw evidence is not READY and must remain visible for review." \
  --acknowledge-warning "DRY_RUN_APPROVAL is missing." \
  --acknowledge-warning "PROMOTION_APPROVAL is missing."
```

## Promotion Approval Command

```bash
npm run ops:approve-ledger-promotion -- \
  --justification "Reviewed Ledger dry-run approval, rollback readiness, and controlled promotion readiness." \
  --acknowledge-warning "Raw evidence is not READY and must remain visible for review." \
  --acknowledge-warning "PROMOTION_APPROVAL is missing."
```

## What Dry-Run Approval Does

Dry-run approval:

- Records an append-only `DRY_RUN_APPROVAL` for `LEDGER`.
- Captures actor and justification.
- Emits `authority.ledger.dry_run.approved`.
- Advances Ledger decision to promotion approval readiness.

Dry-run approval does not:

- Promote Ledger.
- Route ledger posting to Ledger Service.
- Change financial posting logic.
- Change balances.
- Disable comparison or rollback.

## What Promotion Approval Does

Promotion approval:

- Records an append-only `PROMOTION_APPROVAL` for `LEDGER`.
- Captures actor and justification.
- Emits `authority.ledger.promotion.approved`.
- Advances Ledger decision to `READY_FOR_CONTROLLED_PROMOTION`.

Promotion approval does not:

- Promote Ledger.
- Change `LEDGER_AUTHORITY`.
- Route ledger posting to Ledger Service.
- Change balances.
- Change financial posting logic.
- Disable comparison or rollback.

## Next Operator Action

After promotion approval, run Ledger promotion simulation and rollback simulation before any controlled promotion phase.

## Promotion Simulation Command

```bash
npm run ops:simulate-ledger-promotion
```

Promotion simulation verifies:

- Ledger decision is `READY_FOR_CONTROLLED_PROMOTION`.
- Ledger rollback readiness is `READY`.
- Ledger authority is `MONOLITH`.
- Ledger comparison mode is `ENABLED`.
- Ledger Service health is available.

Promotion simulation emits `authority.ledger.promotion.simulated`.

Promotion simulation does not:

- change `LEDGER_AUTHORITY`;
- route ledger posting to Ledger Service;
- change balances;
- change ledger posting logic;
- promote Ledger.

## Rollback Simulation Command

```bash
npm run ops:simulate-ledger-rollback
```

Rollback simulation verifies:

- monolith ledger path is available;
- comparison mode is enabled;
- authority controls are available;
- rollback readiness is `READY`.

Rollback simulation emits `authority.ledger.rollback.simulated`.

Rollback simulation does not:

- change `LEDGER_AUTHORITY`;
- execute rollback;
- modify approvals;
- mutate financial records.
