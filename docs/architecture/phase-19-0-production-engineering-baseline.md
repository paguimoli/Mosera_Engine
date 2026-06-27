# Phase 19.0 - Production Engineering Baseline

Phase 19.0 establishes the first measurement-only production engineering
baseline. It does not optimize queries, add indexes, introduce caching, change
queue topology, change authority routing, or alter financial behavior.

## Measurement Methodology

The baseline samples existing read-only operational evidence:

- public health endpoint latency for HTTP timing
- read-only Supabase count and sample queries for database latency
- existing RabbitMQ management metrics when available
- existing outbox observability for publish latency and backlog age
- existing worker heartbeat and processing metrics
- recent settlement, ledger, and credit evidence counts over a one-hour window
- Node runtime memory, heap, CPU, and uptime

Unavailable telemetry is reported explicitly instead of inferred.

## APIs

- `GET /api/operations/performance-baseline`
- `GET /api/operations/system-throughput`
- `GET /api/operations/runtime-profile`

All APIs require `system.admin` and are read-only.

## Current Capacity Baseline

The baseline reports:

- API average, P95, P99, maximum, fastest, and slowest sampled latency
- database average query duration and longest sampled queries
- RabbitMQ publish rate, consume rate, queue depth, and consumer lag
- outbox pending count, publish latency, retry rate, failed publishes, and
  oldest unpublished event
- settlement transactions/sec
- ledger entries/sec
- credit reservations/sec, exposure updates/sec, and wallet operations/sec
- running, idle, and stale workers
- average worker processing duration when worker metrics exist
- memory, heap, CPU load, Node uptime, and startup approximation

## Known Bottlenecks

The baseline ranks bottlenecks by production impact without applying fixes.
Typical warnings may include:

- aged unpublished outbox events
- no currently active worker heartbeat
- stale worker heartbeat evidence
- RabbitMQ queue depth or unavailable management metrics
- missing database pool telemetry
- unavailable CI build duration telemetry

These are measurement findings only.

## Optimization Roadmap

Future Phase 19 work must follow this sequence:

1. cite the Phase 19.0 baseline metric
2. implement one scoped optimization
3. rerun the same measurement
4. compare before and after
5. keep the optimization only when improvement is measurable

No optimization should be introduced without a baseline and comparison.

## Benchmark Comparison

Use:

```bash
npm run ops:performance-baseline
npm run qa:performance-baseline
```

Record the bottleneck ranking and raw metrics before any optimization phase.
The same scripts should be rerun after each optimization to prove impact.
