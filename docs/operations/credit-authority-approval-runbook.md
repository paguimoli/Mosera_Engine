# Credit Authority Approval Runbook

## Purpose

This runbook describes how operators review and record Credit Wallet authority approvals.

Credit approval workflows are append-only and auditable. They do not change authority by themselves.

## Current Phase

Phase 17.1 supports Credit dry-run approval capture. Credit remains `MONOLITH`.

## Preconditions

Before recording Credit dry-run approval, confirm:

- Settlement is `SERVICE` and `CERTIFIED`.
- Ledger is `SERVICE` and `CERTIFIED`.
- Credit authority is `MONOLITH`.
- Credit comparison mode is `ENABLED`.
- Credit rollback readiness is `READY`.
- Credit promotion decision is `READY_FOR_DRY_RUN_APPROVAL`.
- Current warnings have been reviewed and acknowledged.

## Review Commands

```bash
npm run ops:credit-authority-readiness
npm run ops:credit-promotion-decision
npm run ops:credit-dry-run-evaluation
```

## Dry-Run Approval Command

```bash
npm run ops:approve-credit-dry-run -- \
  --justification "Reviewed Credit shadow evidence and rollback readiness." \
  --acknowledge-warning "Raw evidence is not READY and must remain visible for review." \
  --acknowledge-warning "DRY_RUN_APPROVAL is missing." \
  --acknowledge-warning "PROMOTION_APPROVAL is missing."
```

Use `--correlation-id` when the operator has a stable change or incident identifier. Retrying with the same correlation id returns the existing approval.

## What Dry-Run Approval Does

Dry-run approval:

- records an append-only `DRY_RUN_APPROVAL` for `CREDIT`;
- captures actor user id, username, justification, acknowledged warnings, and correlation id;
- emits `authority.credit.dry_run.approved` through the outbox;
- advances Credit decision to `READY_FOR_PROMOTION_APPROVAL`.

Dry-run approval does not:

- promote Credit;
- change `CREDIT_AUTHORITY`;
- route Credit Wallet authority to Credit Wallet Service;
- change wallet calculations, balances, credit limits, reservations, exposure, settlement logic, or Ledger logic;
- disable comparison mode or rollback.

## Required Acknowledgements

Operators must acknowledge every current warning returned by:

```bash
npm run ops:credit-promotion-decision
```

Known lifecycle warnings may include raw evidence remaining non-ready while lifecycle-adjusted promotion evidence is ready. Raw evidence remains visible for audit and must not be deleted.

## Idempotency

Approvals are append-only. The approval API checks `correlationId` before creating a record:

- first valid request creates one approval;
- retry with the same `correlationId` returns the existing approval;
- no update or delete path exists.

## Verification

Run:

```bash
npm run qa:credit-dry-run-approval
npm run qa:credit-promotion-decision
```

Expected:

- Credit remains `MONOLITH`;
- comparison remains `ENABLED`;
- rollback remains `READY`;
- decision is `READY_FOR_PROMOTION_APPROVAL`;
- Settlement remains `SERVICE` and `CERTIFIED`;
- Ledger remains `SERVICE` and `CERTIFIED`.

## Next Phase

After dry-run approval, Phase 17.2 should capture Credit promotion approval. Promotion approval should still be approval-only unless a later controlled promotion phase explicitly executes Credit authority transfer.
