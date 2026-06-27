# Phase 19.3 - Native Database Observability

## Purpose

Phase 19.3 extends the database performance baseline with native database telemetry and execution-plan visibility where the platform allows it. This phase remains observational only.

No indexes, query rewrites, repository rewrites, migrations, planner setting changes, business logic changes, financial logic changes, routing changes, event contract changes, or authority lifecycle changes are introduced.

## Native Telemetry Methodology

The database observability domain attempts read-only access to native PostgreSQL telemetry views:

- `pg_stat_activity` for active, idle, and waiting sessions
- `pg_locks` for lock waits and lock modes

If the current Supabase/PostgREST access model does not expose those views, the APIs return `UNAVAILABLE` with explicit limitations. Unsupported telemetry is never estimated as healthy or unhealthy.

## Explain-Plan Methodology

The explain-plan report uses the top slow query candidates from the Phase 19.2 database performance report. For each candidate, it records a read-only `EXPLAIN` statement template and the source measurement.

`EXPLAIN ANALYZE` is not used because it can execute the target statement. If the platform does not expose a safe read-only EXPLAIN RPC, plan details are reported as unavailable and the limitation is preserved for operator review.

## Repository Ranking Methodology

Repository timing combines:

- Phase 19.2 repository hotspot indicators
- direct sampled measurements where a sampled query maps to a repository area
- invocation count
- cumulative database time
- average, median, P95, and P99 timing where direct samples exist

Static indicators are kept separate from direct timing so future phases can improve precision without rewriting repositories.

## Endpoint Ranking Methodology

Endpoint timing combines:

- Phase 19.2 endpoint hotspot indicators
- direct sampled measurements where a sampled query maps to an endpoint
- DB time
- application timing observed during the reporting call
- serialization timing when available

Serialization timing is currently unavailable unless a future endpoint wrapper captures it explicitly.

## Platform Limitations

Current limitations may include:

- native session telemetry unavailable through Supabase REST schema exposure
- lock telemetry unavailable through Supabase REST schema exposure
- safe EXPLAIN unavailable without a reviewed read-only RPC
- pool exhaustion events unavailable without pooler telemetry
- longest-running session duration unavailable without `query_start` / `xact_start`

These are reported as explicit limitations rather than inferred metrics.

## Comparison With Phase 19.2

Phase 19.2 established application-level query latency, repository hotspots, endpoint hotspots, read/write ratios, and slow query candidates.

Phase 19.3 adds:

- native session telemetry attempts
- lock telemetry attempts
- explain-plan candidate reporting
- repository timing ranking
- endpoint timing ranking
- explicit visibility gaps for Phase 19.4

## Future Optimization Candidates

Phase 19.4 should still optimize nothing until the selected target has a measured baseline. Candidate next steps:

- add a reviewed read-only native telemetry RPC for `pg_stat_activity`
- add a reviewed read-only native telemetry RPC for `pg_locks`
- add a safe EXPLAIN-only RPC that rejects `ANALYZE`, mutation statements, and planner setting changes
- add endpoint-level DB timing middleware
- add repository-level timing wrappers for the top ranked repositories
- run explain-plan analysis before considering any index changes
