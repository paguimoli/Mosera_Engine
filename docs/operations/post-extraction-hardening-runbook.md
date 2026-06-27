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

## Evidence Hardening

Phase 18.1 adds dedicated read-only evidence commands:

```bash
npm run ops:platform-evidence
npm run ops:ledger-reference-audit
npm run ops:ledger-immutability
npm run ops:ledger-reference-remediation
npm run ops:ledger-immutability-verification
```

Use these after the baseline report when the system is promoted and certified
but still has observability warnings.

The reports are advisory unless they return `ACTION_REQUIRED`. They do not
repair data, dispatch outbox events, mutate authority, execute rollback, or
change financial calculations.

### Ledger Reference Audit

`ops:ledger-reference-audit` samples credit-backed settlement applications and
ledger entries. It reports direct `reference_id` matches, inferred matches from
metadata or idempotency evidence, missing ledger posting evidence, orphan ledger
records, orphan settlement references, and correlation IDs when available.

### Ledger Immutability

`ops:ledger-immutability` verifies append-only evidence from the ledger schema,
reversal-entry links, adjustment chains, and database trigger visibility when
the catalog is available through the API.

If table-level triggers are not visible, the report explicitly records that the
current evidence is based on schema shape, reversal links, idempotency, and
service convention.

`ops:ledger-immutability-verification` adds an evidence-only verification view
that explicitly reports whether UPDATE and DELETE protection is database-level,
application-level, or unknown. It also confirms that no destructive probe and no
destructive trigger creation was attempted.

### Reference Remediation Report

`ops:ledger-reference-remediation` generates an append-only evidence report from
the reference audit. It lists missing references, probable matches, confidence,
and recommended remediation. The report never mutates historical financial
records and every item is marked `mutationAllowed: false`.

### Outbox, Queue, And Worker Evidence

`ops:platform-evidence` includes outbox pending, failed, retry, oldest
unpublished, dispatch latency, and stalled-publisher evidence. It also includes
queue depth, consumer count, publish rate, consume rate, oldest message when
available, dead-letter status, worker last heartbeat, worker version, hostname,
processed jobs, uptime, and stale heartbeat detection.

RabbitMQ management metric gaps are degraded evidence. They should be reviewed,
but they do not fail the platform by themselves.

Phase 18.2 separates `UNKNOWN` metric availability from `UNHEALTHY` queue or
worker conditions. Operators should treat `UNKNOWN` as an observability coverage
gap and `UNHEALTHY` as an operational issue.

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
npm run qa:evidence-hardening
npm run qa:ledger-remediation-hardening
npm run qa:all
```

Expected:

- baseline API requires auth;
- all three domains remain `SERVICE` and `CERTIFIED`;
- comparison remains `ENABLED`;
- rollback remains `READY`;
- services are healthy;
- evidence reports are generated;
- ledger immutability/reference remediation evidence is generated without
  financial mutations;
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

Recommended Phase 18.2 candidates:

- database-level ledger immutability proof;
- ledger reference coverage remediation workflow;
- stale outbox event operator workflow;
- RabbitMQ management metric coverage;
- active worker heartbeat coverage.
