# Phase 13.0 - Worker Scaling & Observability

## Purpose

Phase 13.0 adds production-grade observability for workers, queues, outbox processing, lag, retry pressure, DLQ pressure, and workload-specific throughput.

This phase does not change financial math, credit reservation math, settlement math, accounting math, commission math, authentication, authorization, or the outbox publishing rule.

## Metrics Model

### `worker_heartbeats`

Tracks the latest known state for each worker instance.

Fields include:

- `worker_name`
- `workload_category`
- `instance_id`
- `status`
- `last_seen_at`
- `metadata`

Rows are upserted by `worker_name` and `instance_id`.

### `worker_processing_metrics`

Append-only processing windows for worker throughput.

Fields include:

- `worker_name`
- `workload_category`
- `event_type`
- `processed_count`
- `failed_count`
- `retry_count`
- `total_processing_ms`
- `max_processing_ms`
- `window_start`
- `window_end`

### `worker_failures`

Append-only worker failure records.

Fields include:

- `worker_name`
- `workload_category`
- `event_type`
- `entity_id`
- `correlation_id`
- `error_code`
- `error_message`
- `metadata`

## Instrumentation Behavior

Worker metric writes are best-effort. A metrics write failure is logged as a warning and must not block financial processing, outbox dispatch, RabbitMQ acknowledgement, or RabbitMQ rejection.

Instrumentation currently covers:

- outbox dispatcher heartbeat
- outbox publish success metrics
- outbox publish failure metrics
- RabbitMQ consumer heartbeat
- RabbitMQ ACK success metrics
- RabbitMQ handler failure metrics
- RabbitMQ parse failure metrics

## Outbox Observability

Outbox metrics include:

- pending count
- failed count
- dead-letter count
- published count
- oldest unpublished age
- retry count
- average publish latency
- max publish latency
- workload category distribution

## Queue Observability

Queue metrics include:

- queue name
- DLQ name
- ready messages
- unacked messages
- consumer count
- DLQ ready messages
- status

If RabbitMQ management is unavailable or a queue has not yet been declared, the queue reports `DEGRADED` with an error instead of failing the full endpoint.

## Lag Classification

Lag severity values:

- `HEALTHY`
- `WARNING`
- `CRITICAL`
- `DEGRADED`

Default thresholds:

- outbox warning age: `300` seconds
- outbox critical age: `900` seconds
- queue warning ready count: `100`
- critical financial queue critical ready count: `25`
- heartbeat stale age: `300` seconds

Environment overrides:

- `WORKER_OUTBOX_WARNING_AGE_SECONDS`
- `WORKER_OUTBOX_CRITICAL_AGE_SECONDS`
- `WORKER_QUEUE_WARNING_READY_COUNT`
- `WORKER_CRITICAL_QUEUE_CRITICAL_READY_COUNT`
- `WORKER_HEARTBEAT_STALE_SECONDS`
- `WORKER_INSTANCE_ID`

## Protected APIs

- `GET /api/operations/metrics`
- `GET /api/operations/workers`
- `GET /api/operations/outbox`
- `GET /api/operations/queues`
- `GET /api/operations/queues/health`

All endpoints require `system.admin`.

## Operational Scripts

- `npm run ops:metrics`
- `npm run ops:workers`
- `npm run ops:outbox`
- `npm run ops:queues`
- `npm run ops:queue-health`

## Limitations

- Metrics are in Postgres, not a time-series database.
- This phase does not add autoscaling.
- Queue status may report `DEGRADED` until workers or publishers declare the queues.
- Historical worker activity before the migration is not backfilled.
- When heartbeat tables are unavailable or empty, worker observations may be derived from recent `job_runs` for operational continuity.
