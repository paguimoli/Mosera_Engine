# Phase 19.1 - Outbox Dispatcher Throughput & Worker Activation

## Purpose

Phase 19.1 addresses the first production engineering bottleneck found after the post-extraction baseline: outbox events were accumulating while dispatcher throughput was zero and queue workers were not continuously active.

This phase is operational hardening only. It does not change authority ownership, event contracts, settlement logic, ledger posting logic, credit wallet logic, balances, reservations, exposure, routing, comparison mode, or rollback readiness.

## Root Cause

The platform already had:

- a one-shot authenticated outbox dispatch endpoint
- reusable worker consumer scripts
- RabbitMQ queue topology
- worker heartbeat persistence

The platform did not continuously run those components in the local/QA Docker topology. Idle consumers also refreshed heartbeats only when they started or consumed messages, which made healthy waiting workers appear stale over time.

## Implemented Activation Model

The runtime image now contains the worker script sources needed by the existing TypeScript script runner. Docker Compose starts:

- `outbox-dispatcher`
- `worker-critical-financial`
- `worker-ticket-lifecycle`
- `worker-settlement`
- `worker-accounting`
- `worker-commission`
- `worker-reconciliation`
- `worker-operational-access`
- `worker-reporting`

The dispatcher uses the existing outbox dispatch service and RabbitMQ publisher. It publishes only append-only outbox events that are already eligible for dispatch.

Default dispatcher settings:

- batch size: `50`
- idle interval: `5000ms`
- backlog interval: `250ms`
- heartbeat interval: `30000ms`

These settings can be overridden with:

- `OUTBOX_DISPATCH_BATCH_SIZE`
- `OUTBOX_DISPATCH_IDLE_INTERVAL_MS`
- `OUTBOX_DISPATCH_BACKLOG_INTERVAL_MS`
- `WORKER_HEARTBEAT_INTERVAL_MS`

## Worker Heartbeats

RabbitMQ consumers now emit periodic idle `ACTIVE` heartbeats while waiting for messages. This distinguishes active idle workers from stale workers without changing how queue messages are handled.

Running worker counts in the performance baseline are based on fresh heartbeats. Historical stale heartbeats remain visible as evidence but do not count as currently running workers.

## Measurement

`ops:performance-baseline` now captures a before/after measurement window and reports:

- authority state
- outbox pending before/after
- outbox backlog improvement
- published event delta
- outbox throughput during the window
- dispatcher latency
- queue depth delta
- queue drain rate
- running and stale worker counts
- worker throughput
- heartbeat freshness

The operation remains measurement-only. It does not manually dispatch events.

## QA Expectations

`qa:performance-baseline` validates that:

- operations APIs require authentication
- baseline APIs remain measurement-only
- workers become freshly active
- outbox backlog decreases or published event count increases when backlog exists
- failed and dead-letter outbox counts do not increase
- recent published outbox samples do not contain duplicate IDs
- RabbitMQ metrics are used when available and degrade gracefully when unavailable
- Settlement, Ledger, and Credit remain `SERVICE / CERTIFIED`
- comparison remains enabled
- rollback remains ready
- financial and authority row counts do not change

If there is no pending outbox backlog, QA skips the backlog decrease assertion and still requires active fresh worker heartbeats.

## Exit Criteria

Phase 19.1 is complete when:

- Docker Compose starts the dispatcher and all existing worker categories
- fresh worker heartbeats are visible
- outbox publishing throughput is non-zero when backlog exists
- queue depth does not grow beyond dispatched activity allowance
- `qa:performance-baseline` passes
- `qa:all` passes

## Next Phase

Phase 19.2 should use the new before/after reporting to identify the next bottleneck. Candidate areas are dispatcher batch tuning, queue prefetch tuning, database query latency, or HTTP endpoint latency, depending on the measured Phase 19.1 result.
