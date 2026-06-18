# Worker Observability Runbook

## Purpose

Use this runbook to review worker health, queue lag, outbox lag, retry pressure, and DLQ pressure before and during controlled beta operations.

## Daily Checks

Run:

```bash
OPS_ADMIN_SESSION_TOKEN=<token> npm run ops:metrics
OPS_ADMIN_SESSION_TOKEN=<token> npm run ops:queues
OPS_ADMIN_SESSION_TOKEN=<token> npm run ops:outbox
OPS_ADMIN_SESSION_TOKEN=<token> npm run ops:workers
```

Review:

- lag severity
- outbox pending count
- oldest unpublished outbox age
- retry count
- DLQ count
- queue ready count
- queue unacked count
- worker heartbeat age
- recent worker failures

## Lag Severity

`HEALTHY`:

- no DLQ messages
- outbox age below warning threshold
- queues below warning threshold

`WARNING`:

- oldest outbox event exceeds warning threshold
- queue backlog exceeds warning threshold
- worker heartbeats exist but no active workers are observed

`CRITICAL`:

- outbox has dead-lettered events
- oldest unpublished outbox event exceeds critical threshold
- critical financial queue backlog exceeds threshold
- any DLQ has ready messages

`DEGRADED`:

- RabbitMQ management metrics are unavailable
- queue has not yet been declared

## Scale-Up Procedure

1. Confirm the lag is real using `npm run ops:metrics`.
2. Identify the affected workload category.
3. Start only the needed worker:

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

4. Recheck `npm run ops:queues`.
5. Confirm ready count decreases and unacked count does not grow indefinitely.

## Low-Priority Control

If critical queues lag, stop or defer low-priority/reporting workers first. Reporting and reconciliation must not starve financial, ticket, or settlement workloads.

## DLQ Response

DLQ messages require manual review. Operators must collect:

- event type
- aggregate type
- aggregate id
- correlation id
- worker failure record
- original outbox event
- structured logs

Do not delete DLQ messages or edit financial records to clear metrics.

## Retry Response

Increasing retry count indicates downstream pressure or handler failure. Check:

- RabbitMQ availability
- worker logs
- Supabase/Postgres availability
- event payload schema
- idempotency behavior

## Escalation

Escalate immediately when:

- `CRITICAL_FINANCIAL` backlog exceeds threshold
- any financial DLQ message exists
- outbox critical age is breached
- worker failures repeat for the same event type
- queue metrics are degraded during active beta traffic

## Prohibited Actions

- Do not publish business events directly to RabbitMQ.
- Do not bypass outbox.
- Do not delete outbox, ledger, ticket, settlement, accounting, commission, or reconciliation records.
- Do not clear DLQ messages without root-cause review.
- Do not bypass authentication to read operations endpoints.
