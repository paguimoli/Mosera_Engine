# Queue Operations Runbook

## Purpose

This runbook explains how operators review queue health, start isolated workers, and respond to lag or DLQ conditions without bypassing the outbox, RabbitMQ, authentication, or audit controls.

## Queue Topology

The platform uses one durable RabbitMQ topic exchange and isolated durable queues by workload:

- `CRITICAL_FINANCIAL`: ledger, wallet, credit reservation, credit settlement, balance events.
- `TICKET_LIFECYCLE`: accepted, cancelled, and settled ticket events.
- `SETTLEMENT`: settlement run lifecycle events.
- `ACCOUNTING`: weekly accounting and snapshot events.
- `COMMISSION`: commission run and adjustment events.
- `RECONCILIATION`: reconciliation run, finding, acknowledgement, and resolution events.
- `OPERATIONAL_ACCESS`: break-glass and session security events.
- `REPORTING_LOW_PRIORITY`: report export and unknown low-priority events.

## Starting Workers

Start only the worker needed for the workload under review:

```bash
npm run worker:critical-financial
npm run worker:ticket-lifecycle
npm run worker:settlement
npm run worker:accounting
npm run worker:commission
npm run worker:reconciliation
npm run worker:operational-access
npm run worker:reporting
```

Workers use manual acknowledgement and `prefetch = 1`.

## Queue Health

Use the protected API:

```bash
GET /api/operations/queues/health
```

Or run:

```bash
OPS_ADMIN_SESSION_TOKEN=<token> npm run ops:queue-health
```

Review:

- `outboxPending`
- `outboxFailed`
- `outboxDeadLetter`
- `oldestUnpublishedAgeSeconds`
- `failedJobCount`
- queue ready count
- queue unacked count
- DLQ ready count

## Severity Guidance

High:

- Any `CRITICAL_FINANCIAL` DLQ message.
- Any `TICKET_LIFECYCLE` or `SETTLEMENT` queue with growing lag during active play.
- Oldest unpublished outbox age increasing while dispatcher jobs are failing.

Medium:

- Accounting or commission lag outside close windows.
- Reconciliation DLQ findings that do not block current ticket settlement.

Low:

- Reporting queue lag with no operational deadline.

## Operational Response

1. Check `/api/operations/queues/health`.
2. Confirm RabbitMQ is reachable.
3. Confirm the outbox dispatcher job is running.
4. Start or restart only the affected workload consumer.
5. Inspect structured logs using correlation IDs.
6. If DLQ contains financial, ticket, or settlement events, pause beta expansion until reviewed.
7. Record the operator action in the operational incident notes.

## DLQ Policy

DLQ messages must never be manually deleted to make dashboards green. Operators must identify:

- original event type
- aggregate type and id
- correlation id
- failure reason
- whether the source record still exists
- whether retry is safe and idempotent

Manual direct RabbitMQ replay is not implemented in this phase. Replay planning
is available only through guarded evidence tooling.

## DLQ Triage

Use inspect mode first. It does not publish, delete, acknowledge, or mutate
messages:

```bash
npm run ops:dlq -- --mode=inspect --input=<dlq-export.json>
```

The input must be an approved DLQ export or a synthetic QA fixture. Triage must
record:

- DLQ name
- message id
- routing key
- event type
- aggregate type and id
- correlation id
- idempotency key evidence
- reason the original handler failed

Malformed messages, unsupported routing keys, and messages without idempotency
evidence are not replay candidates.

## Replay Approval

Replay planning is guarded and requires all of:

- `DLQ_REPLAY_APPROVED=true`
- `DLQ_REPLAY_IDEMPOTENCY_CONFIRMED=true`
- `DLQ_REPLAY_APPROVAL_TOKEN=<change-or-incident-id>`
- `DLQ_REPLAY_OPERATOR=<operator-id>`

Run approved replay planning with:

```bash
DLQ_REPLAY_APPROVED=true \
DLQ_REPLAY_IDEMPOTENCY_CONFIRMED=true \
DLQ_REPLAY_APPROVAL_TOKEN=<change-or-incident-id> \
DLQ_REPLAY_OPERATOR=<operator-id> \
npm run ops:dlq -- --mode=replay --input=<dlq-export.json>
```

The tool produces a replay plan and evidence artifact. It does not directly
publish messages to RabbitMQ in this phase.

## Replay Evidence

Store the generated evidence artifact with the incident or change record. The
artifact includes source digest, operator, approval token digest, eligible
messages, blocked malformed messages, and replay plan.

## Rollback / Failure Handling

If replay planning exposes inconsistent state, missing source records,
unsupported routing keys, or missing idempotency evidence:

1. Stop replay planning.
2. Keep the message in DLQ.
3. Capture the evidence artifact.
4. Open a corrective incident.
5. Use domain-specific recovery tooling rather than manual queue edits.

## What Must Never Be Done Manually

- Do not publish business events directly to RabbitMQ.
- Do not edit `outbox_events` payloads.
- Do not delete financial, ticket, settlement, accounting, commission, reconciliation, or outbox records.
- Do not reset wallet balances from queue tooling.
- Do not bypass authentication or authorization to inspect queue health.
- Do not acknowledge a queue message unless a consumer has successfully handled it.

## Pre-Beta Procedure

Before beta sessions:

1. Run `npm run ops:queue-health`.
2. Confirm no critical financial DLQ messages.
3. Confirm no settlement DLQ messages.
4. Confirm outbox pending count is stable or decreasing.
5. Confirm oldest unpublished outbox age is within the operational threshold.
6. Confirm reconciliation and reporting lag cannot starve critical queues.
