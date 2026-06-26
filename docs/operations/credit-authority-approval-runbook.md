# Credit Authority Approval Runbook

## Purpose

This runbook describes how operators review and record Credit Wallet authority approvals.

Credit approval workflows are append-only and auditable. They do not change authority by themselves.

## Current Phase

Phase 17.3 supports Credit dry-run approval, promotion approval, and explicit controlled promotion execution.

## Preconditions

Before recording Credit dry-run approval, confirm:

- Settlement is `SERVICE` and `CERTIFIED`.
- Ledger is `SERVICE` and `CERTIFIED`.
- Credit authority is `MONOLITH`.
- Credit comparison mode is `ENABLED`.
- Credit rollback readiness is `READY`.
- Credit promotion decision is `READY_FOR_DRY_RUN_APPROVAL`.
- Current warnings have been reviewed and acknowledged.

Before recording Credit promotion approval, also confirm:

- Credit `DRY_RUN_APPROVAL` exists.
- Credit promotion decision is `READY_FOR_PROMOTION_APPROVAL`.
- Credit authority is still `MONOLITH`.
- Credit comparison mode is still `ENABLED`.
- Credit rollback readiness is still `READY`.
- Current warnings have been reviewed and acknowledged.

Before executing controlled promotion, confirm:

- Credit `DRY_RUN_APPROVAL` exists.
- Credit `PROMOTION_APPROVAL` exists.
- Credit promotion decision is `READY_FOR_CONTROLLED_PROMOTION`.
- Credit authority is still `MONOLITH`.
- Credit comparison mode is still `ENABLED`.
- Credit rollback readiness is still `READY`.
- Credit Wallet Service health is healthy.
- Settlement remains `SERVICE` and `CERTIFIED`.
- Ledger remains `SERVICE` and `CERTIFIED`.

## Review Commands

```bash
npm run ops:credit-authority-readiness
npm run ops:credit-promotion-decision
npm run ops:credit-dry-run-evaluation
npm run ops:credit-promotion-status
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

## Promotion Approval Command

```bash
npm run ops:approve-credit-promotion -- \
  --justification "Reviewed Credit dry-run approval and controlled promotion readiness." \
  --acknowledge-warning "Raw evidence is not READY and must remain visible for review." \
  --acknowledge-warning "PROMOTION_APPROVAL is missing."
```

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

## What Promotion Approval Does

Promotion approval:

- records an append-only `PROMOTION_APPROVAL` for `CREDIT`;
- captures actor user id, username, justification, acknowledged warnings, and correlation id;
- emits `authority.credit.promotion.approved` through the outbox;
- advances Credit decision to `READY_FOR_CONTROLLED_PROMOTION`.

Promotion approval does not:

- promote Credit;
- change `CREDIT_AUTHORITY`;
- route Credit Wallet authority to Credit Wallet Service;
- change wallet calculations, balances, credit limits, reservations, exposure, Settlement logic, or Ledger logic;
- disable comparison mode or rollback.

## Controlled Promotion Command

```bash
npm run ops:credit-promote -- \
  --justification "Reviewed Credit controlled promotion checklist and approvals." \
  --correlation-id "change-credit-promotion-001"
```

Controlled promotion:

- requires `domain: CREDIT` and explicit `mode: EXECUTE`;
- requires non-empty justification;
- requires `DRY_RUN_APPROVAL` and `PROMOTION_APPROVAL`;
- changes Credit authority from `MONOLITH` to `SERVICE`;
- keeps Credit comparison mode `ENABLED`;
- keeps Settlement and Ledger authorities unchanged;
- emits `authority.credit.promoted` through the outbox.

It does not change wallet calculations, balances, credit limits, reservations, exposure, settlement logic, Ledger logic, or accounting behavior.

## Config Behavior

The protected API updates the runtime authority configuration through the same controlled authority mechanism used by Settlement and Ledger.

The operation script also updates only these local `.env.local` keys after successful execution:

- `CREDIT_AUTHORITY=SERVICE`
- `CREDIT_COMPARISON_MODE=ENABLED`

`.env.local` is gitignored. Do not edit unrelated environment values as part of Credit promotion.

## Rollback Sequence

Phase 17.3 keeps rollback readiness available but does not execute rollback. Operators should:

- confirm `npm run ops:credit-promotion-status` reports Credit `SERVICE` and rollback `READY`;
- run `npm run ops:simulate-credit-rollback` before any rollback window;
- keep comparison mode enabled;
- follow the Credit rollback execution runbook when that execution phase is available.

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

Promotion execution is also idempotent. If Credit is already `SERVICE`, retrying the execution command returns the existing promoted state and does not emit another `authority.credit.promoted` event.

## Verification

Run:

```bash
npm run qa:credit-dry-run-approval
npm run qa:credit-promotion-approval
npm run qa:credit-promotion-execution
npm run qa:credit-promotion-decision
```

Expected:

- Credit is `MONOLITH` before controlled promotion and `SERVICE` after successful execution;
- comparison remains `ENABLED`;
- rollback remains `READY`;
- decision is `READY_FOR_CONTROLLED_PROMOTION` after promotion approval and `PROMOTED` after execution;
- Settlement remains `SERVICE` and `CERTIFIED`;
- Ledger remains `SERVICE` and `CERTIFIED`.

## Post-Promotion Monitoring

After controlled promotion, operators should continue monitoring Credit comparison and rollback signals. Intentional QA evidence must remain visible in lifecycle reports, and post-promotion evidence should be reviewed before any future Credit certification phase.

Use:

```bash
npm run ops:credit-post-promotion-status
```

Review:

- Credit authority is `SERVICE`;
- comparison mode is `ENABLED`;
- Credit Wallet Service health is available;
- rollback readiness is `READY`;
- rollback trigger is not active;
- post-promotion mismatches, failures, and critical mismatches are reviewed;
- recommendation is understood by the operator.

`REVIEW_REQUIRED` means rollback is still available but an operator must review post-promotion activity, aligned evidence, or warnings before proceeding. With zero post-promotion Credit activity, `REVIEW_REQUIRED` is expected.

## Rollback Drill

Run a simulation-only drill:

```bash
npm run ops:simulate-credit-rollback-drill -- \
  --correlation-id "change-credit-rollback-drill-001"
```

The drill:

- emits `authority.credit.rollback.drill.simulated`;
- captures actor user id, correlation id, and created timestamp in outbox payload;
- validates rollback prerequisites;
- does not change Credit authority;
- does not change balances, reservations, exposure, wallet calculations, Settlement, or Ledger.

Operators should preserve drill output with the promotion evidence package.

## Phase 17.4 Exit Criteria

Before moving beyond post-promotion monitoring, confirm:

- Settlement remains `SERVICE` and `CERTIFIED`;
- Ledger remains `SERVICE` and `CERTIFIED`;
- Credit remains `SERVICE`;
- comparison remains `ENABLED`;
- rollback readiness remains `READY`;
- rollback drill passed without authority or financial-state mutation;
- post-promotion activity and warnings have been reviewed.

## Activity Certification Readiness

After rollback drill evidence is captured, generate clean post-promotion activity:

```bash
npm run qa:credit-post-promotion-activity
```

Then review:

```bash
npm run ops:credit-certification-status
```

`READY_FOR_CERTIFICATION` means:

- Credit remains `SERVICE`;
- comparison remains `ENABLED`;
- rollback remains `READY`;
- Credit Wallet Service health is healthy;
- post-promotion Credit wallet activity exists;
- post-promotion mismatches are zero;
- post-promotion failures are zero;
- post-promotion critical mismatches are zero.

`READY_FOR_CERTIFICATION` is not certification. It only means an operator can proceed to the formal certification capture phase.

## Next Phase

After post-promotion activity readiness, Phase 17.6 should capture explicit Credit operator certification if evidence remains clean.

## Operator Certification

Formal certification is captured only after stabilization reports `READY_FOR_CERTIFICATION`:

```bash
npm run ops:credit-certification-status
```

Certification requires:

- Credit authority is `SERVICE`;
- comparison remains `ENABLED`;
- rollback remains `READY`;
- promotion decision is `PROMOTED`;
- post-promotion Credit activity exists;
- post-promotion mismatches, failures, and critical mismatches are zero;
- Settlement remains `SERVICE` and `CERTIFIED`;
- Ledger remains `SERVICE` and `CERTIFIED`;
- operator justification is recorded;
- every current certification warning is acknowledged.

Capture certification with:

```bash
npm run ops:certify-credit -- \
  --justification "Credit Wallet Service post-promotion evidence reviewed and accepted." \
  --acknowledge-warning "Operator certification is still required before marking Credit as CERTIFIED." \
  --correlation-id "change-credit-certification-001"
```

The command calls `POST /api/authority/certification/credit` and creates an append-only `CREDIT_CERTIFICATION` approval record. Retrying the same `correlationId` returns the original approval and does not update or delete historical approvals.

Certification emits the outbox event `authority.credit.certified` with the approval id, actor user id, correlation id, and `certifiedAt`. The event is written to the outbox only; direct RabbitMQ publishing is not used.

After certification, `GET /api/authority/credit-stabilization-status` reports:

- `certificationStatus: CERTIFIED`;
- `certificationApprovalId`;
- `certifiedAt`.

`CERTIFIED` means the operator accepted the clean post-promotion Credit evidence. It does not change Credit authority, routing, wallet calculations, balances, reservations, exposure, Settlement, Ledger, comparison mode, or rollback readiness.

## Post-Certification Verification

Run:

```bash
npm run qa:credit-certification
npm run qa:all
```

Expected:

- Settlement remains `SERVICE` and `CERTIFIED`;
- Ledger remains `SERVICE` and `CERTIFIED`;
- Credit remains `SERVICE` and `CERTIFIED`;
- Credit comparison remains `ENABLED`;
- Credit rollback remains `READY`;
- no balance, reservation, exposure, wallet, routing, Settlement, or Ledger mutation occurs.
