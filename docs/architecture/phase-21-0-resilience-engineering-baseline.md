# Phase 21.0 - Resilience Engineering Baseline

## Objective

Phase 21.0 establishes the first resilience and failure-recovery baseline after completion of performance engineering.

This phase is measurement and validation only. It does not change authority routing, financial logic, settlement, ledger, credit, wallet, ticket, event semantics, comparison mode, rollback readiness, schema, or worker behavior.

## Methodology

The baseline uses protected read-only operations APIs to collect current recovery evidence:

- `GET /api/operations/resilience-status`
- `GET /api/operations/failure-recovery-baseline`
- `GET /api/operations/retry-idempotency-status`
- `GET /api/operations/service-recovery-summary`

The checks aggregate existing authority, rollback, service health, RabbitMQ, Redis, outbox, worker, retry, and duplicate-prevention evidence.

## Safe Failure Assumptions

All scenarios are simulated or advisory. Phase 21.0 does not stop containers, restart services, disable Redis, disconnect RabbitMQ, inject malformed messages, mutate queues, retry outbox events, or write recovery records.

The baseline assumes Docker Compose service restarts are reserved for a later explicitly controlled drill phase.

## Simulated Scenarios

- Settlement Service recovery readiness
- Ledger Service recovery readiness
- Credit Wallet Service recovery readiness
- RabbitMQ connectivity and queue visibility
- Redis connectivity and degraded-state reporting
- Outbox dispatcher recovery evidence
- Worker lifecycle visibility and stale heartbeat separation
- Retry and idempotency evidence

## Not Destructively Tested

- Container restarts
- RabbitMQ disconnects
- Redis outage simulation
- Queue purge or replay
- Outbox retry execution
- Rollback execution
- Financial write-path retry storms

## Service Recovery Evidence

Service recovery readiness is based on:

- Service health endpoint visibility
- `SERVICE / CERTIFIED` authority baseline
- `ENABLED` comparison mode
- `READY` rollback readiness
- Read-only persisted count snapshots proving no mutation during QA

## Worker Recovery Evidence

Worker recovery evidence reports:

- Active worker heartbeats
- Fresh heartbeat count
- Stale worker evidence separated from active workers
- Worker version, hostname, uptime, and processed jobs where available

Historical stale heartbeat evidence is advisory and does not fail the baseline by itself.

## Queue Recovery Evidence

Queue recovery evidence reports:

- RabbitMQ queue visibility
- Consumer counts when management metrics are available
- Queue depth
- Publish and consume rates when available
- Dead-letter status

RabbitMQ management metric unavailability is reported as degraded evidence rather than treated as data corruption.

## Retry And Idempotency Evidence

Retry and idempotency evidence reports:

- Outbox retry count
- Correlation-id evidence
- Sampled duplicate-prevention checks for tickets, settlements, ledger entries, and credit reservations

No repairs or deduplication are performed.

## Known Limitations

- Redis outage is not forcibly simulated.
- RabbitMQ reconnect behavior is inferred from current queue and worker evidence.
- Service restart recovery is not destructively tested.
- Duplicate-prevention checks are sampled and read-only.
- Existing historical stale worker evidence remains visible as advisory observability data.

## Recommendation For Phase 21.1

Introduce explicitly controlled, non-production destructive drills in Docker Compose only after confirming operator approval and preserving before/after financial invariants.
