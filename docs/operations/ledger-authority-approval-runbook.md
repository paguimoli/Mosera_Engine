# Ledger Authority Approval Runbook

## Purpose

This runbook describes how operators review and record Ledger authority approvals.

Ledger approval workflows are append-only and auditable. They do not change authority by themselves.

## Current Phase

Phase 16.1 supports Ledger dry-run approval capture only.

## Preconditions

Before recording Ledger dry-run approval, confirm:

- Ledger authority is `MONOLITH`.
- Ledger comparison mode is `ENABLED`.
- Ledger rollback readiness is `READY`.
- Ledger promotion decision is `READY_FOR_DRY_RUN_APPROVAL`.
- Ledger promotion evidence is `READY`.
- Raw evidence warnings have been reviewed.

## Review Commands

```bash
npm run ops:ledger-authority-readiness
npm run ops:ledger-promotion-decision
npm run ops:ledger-dry-run-evaluation
```

## Approval Command

```bash
npm run ops:approve-ledger-dry-run -- \
  --justification "Reviewed Ledger shadow evidence and rollback readiness." \
  --acknowledge-warning "Raw evidence is not READY and must remain visible for review." \
  --acknowledge-warning "DRY_RUN_APPROVAL is missing." \
  --acknowledge-warning "PROMOTION_APPROVAL is missing."
```

## What Approval Does

Approval:

- Records an append-only `DRY_RUN_APPROVAL` for `LEDGER`.
- Captures actor and justification.
- Emits `authority.ledger.dry_run.approved`.
- Advances Ledger decision to promotion approval readiness.

Approval does not:

- Promote Ledger.
- Route ledger posting to Ledger Service.
- Change financial posting logic.
- Change balances.
- Disable comparison or rollback.

## Next Operator Action

After dry-run approval, continue collecting and reviewing Ledger evidence before any Ledger promotion approval phase.
