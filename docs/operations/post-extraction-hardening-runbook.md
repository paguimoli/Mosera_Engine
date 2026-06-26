# Post-Extraction Hardening Runbook

## Scope

Use this runbook after Settlement, Ledger, and Credit are all `SERVICE` authority and `CERTIFIED`.

Do not use this workflow to change authority, routing, balances, reservations, exposure, settlement logic, ledger logic, credit logic, comparison mode, or rollback readiness.

## Baseline Status

Run:

```bash
npm run ops:authority-baseline-status
```

Expected:

- Settlement is `SERVICE` and `CERTIFIED`;
- Ledger is `SERVICE` and `CERTIFIED`;
- Credit is `SERVICE` and `CERTIFIED`;
- comparison mode is `ENABLED`;
- rollback readiness is `READY`;
- services are healthy.

`WARNING` status is acceptable for advisory hardening items if there are no blockers. Preserve warnings with the phase evidence package.

## Hardening Report

Run:

```bash
npm run ops:post-extraction-hardening-report
```

Review:

- authority baseline;
- financial invariant checks;
- rollback drill readiness;
- outbox/event audit;
- service and worker observability;
- blockers;
- warnings.

## Financial Invariants

Operators should verify that the report includes:

- persisted settlement application evidence;
- ledger reference coverage for settlement evidence;
- reservation exposure consistency;
- no negative available credit in sampled active credit wallets;
- no settled reservations missing settlement applications;
- ledger append-only posture.

These checks are read-only and advisory/reporting only.

## Rollback Expectations

Rollback readiness must remain `READY` for Settlement, Ledger, and Credit. The baseline does not execute rollback. If rollback readiness becomes `WARNING` or `BLOCKED`, pause new extraction work and review the domain-specific rollback runbook.

## Event Audit Expectations

Review:

- pending outbox count;
- failed outbox count;
- dead-letter count;
- recent authority events;
- recent certification events.

Do not edit or delete outbox rows. Use the existing dispatcher and worker runbooks for lag or failure response.

## Golden Path Validation

Run:

```bash
npm run qa:post-extraction-golden-path
```

This executes the existing Credit launch flow and confirms the promoted baseline remains intact after ticket, settlement, accounting, commission, and reconciliation activity.

## Full QA

Run:

```bash
npm run qa:post-extraction-hardening
npm run qa:all
```

Expected:

- baseline API requires auth;
- all three domains remain `SERVICE` and `CERTIFIED`;
- comparison remains `ENABLED`;
- rollback remains `READY`;
- services are healthy;
- golden path passes;
- full QA passes.

## Exit Criteria

Exit Phase 18.0 only when:

- `npm run qa:post-extraction-golden-path` passes;
- `npm run qa:post-extraction-hardening` passes;
- `npm run qa:all` passes;
- blockers are empty;
- warnings are reviewed and accepted for the next phase.

## Next Candidate Domains

Recommended Phase 18.1 candidates:

- worker/outbox dispatcher hardening;
- reconciliation service extraction planning;
- reporting service extraction planning;
- cashier/payment boundary hardening;
- notification service extraction planning.
