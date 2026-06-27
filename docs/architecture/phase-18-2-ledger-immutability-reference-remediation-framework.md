# Phase 18.2 - Ledger Immutability & Reference Remediation Framework

Phase 18.2 strengthens evidence and auditability around ledger immutability,
settlement-to-ledger reference coverage, outbox lag, and worker/queue evidence.

This phase is evidence-only. It does not change authority, routing, settlement
logic, ledger calculations, wallet behavior, exposure, reservations, promotion
decisions, or historical financial records.

## Ledger Immutability Verification

The verification endpoint is:

```text
GET /api/operations/ledger-immutability-verification
```

It reports:

- whether ledger updates are database-protected or application-enforced;
- whether ledger deletes are database-protected or application-enforced;
- append-only enforcement mode;
- reversal chain integrity;
- adjustment chain integrity;
- database trigger evidence when visible;
- whether any destructive probe or destructive trigger was attempted.

The endpoint never attempts an update or delete probe and never creates
destructive triggers automatically. If database trigger evidence is unavailable,
the report clearly identifies the enforcement mode as `UNKNOWN` or
`APPLICATION_ENFORCED` rather than claiming database enforcement.

## Ledger Reference Coverage Audit

The reference audit endpoint remains:

```text
GET /api/operations/ledger-reference-audit
```

It identifies:

- settlement applications without ledger references;
- ledger entries without settlement references;
- inferred relationships;
- direct relationships;
- orphan records;
- correlation IDs where available.

The audit never backfills or repairs data.

## Reference Remediation Report

The remediation endpoint is:

```text
GET /api/operations/ledger-reference-remediation
```

It generates append-only evidence describing:

- missing references;
- probable matches;
- confidence;
- recommended remediation;
- explicit `mutationAllowed: false` on every item.

The report is intentionally generated evidence only. Any future remediation or
backfill must be a separate operator-approved phase.

## Outbox Hardening

Outbox evidence now includes:

- aged unpublished events;
- retry candidates;
- failed publication counts;
- dispatch latency;
- oldest pending events;
- stalled publisher detection.

No dispatch, retry, or outbox row mutation is performed by the evidence
endpoints.

## Worker And Queue Evidence

Queue evidence separates unavailable metrics from unhealthy queues. Unavailable
RabbitMQ management metrics are reported as `UNKNOWN`; queues with concrete
critical evidence are `UNHEALTHY`.

Worker evidence separates:

- active workers;
- idle workers;
- stale workers;
- unknown worker state.

Idle or intentionally offline workers produce warnings instead of hard failures.

## Validation

Required validation:

```bash
npm run qa:ledger-remediation-hardening
npm run qa:evidence-hardening
npm run qa:all
```

The QA verifies protected APIs, evidence-only behavior, append-only remediation
output, no financial row-count mutation, and unchanged authority state.
