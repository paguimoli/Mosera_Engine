# Phase 18.1 - Evidence & Observability Hardening

Phase 18.1 adds read-only evidence and observability reports after Settlement,
Ledger, and Credit have all been promoted and certified.

This phase does not change authority, routing, rollback readiness, comparison
mode, balances, reservations, exposure, settlement calculations, ledger posting,
or Credit Wallet behavior.

## Evidence Pipeline

The unified evidence endpoint is:

```text
GET /api/operations/platform-evidence
```

It aggregates authority baseline status, cross-domain financial invariants,
ledger reference audit, ledger immutability verification, outbox health, queue
health, worker health, and operations lag metrics.

The overall status is:

- `READY` when all evidence is clean;
- `WARNING` when advisory gaps exist but no mutation or authority risk is
  detected;
- `ACTION_REQUIRED` when failed/dead-lettered events, broken references, or
  other hard operational issues require operator action.

## Ledger Reference Traceability

The ledger reference audit endpoint is:

```text
GET /api/operations/ledger-reference-audit
```

It verifies that sampled credit-backed settlement applications have ledger
posting evidence, that ledger postings reference settlement evidence directly or
through metadata/idempotency evidence, and that orphan settlement ledger records
are surfaced with IDs and correlation IDs where available.

The audit is reporting-only. It never repairs references and never writes ledger
rows.

## Ledger Immutability

The ledger immutability endpoint is:

```text
GET /api/operations/ledger-immutability
```

It reports update evidence from the ledger row shape, delete detection
limitations, reversal entries and original-entry references, manual adjustment
reference/idempotency chains, and database trigger visibility when available.

If table-level trigger evidence is unavailable through the API, the report says
so explicitly and falls back to schema shape, reversal links, idempotency, and
service convention evidence. It never attempts update/delete probes.

## Outbox, Queue, And Worker Evidence

Outbox reporting now includes oldest unpublished event evidence, retry count,
dispatch latency, and stalled publisher detection.

Queue reporting includes queue depth, consumer count, publish/consume rates when
RabbitMQ management metrics are available, dead-letter status, and graceful
degradation when management metrics are unavailable.

Worker reporting includes last heartbeat, active worker detection, worker
version, hostname, processed jobs, and uptime evidence where emitted by worker
heartbeat metadata. Workers that are intentionally offline are reported as
`WARNING`, not as evidence failures.

## Operator Exit Criteria

Phase 18.1 exits when:

- `npm run qa:evidence-hardening` passes;
- `npm run qa:all` passes;
- all three authorities remain `SERVICE / CERTIFIED`;
- comparison remains `ENABLED`;
- rollback remains `READY`;
- remaining evidence warnings are documented and actionable.

## Next Candidate Domains

Phase 18.2 should use this evidence layer to harden either ledger reference
coverage and append-only proof at the database boundary, outbox stale-event
remediation workflow, active worker heartbeat coverage, or RabbitMQ management
metric availability.
