# Phase 19.4 - Query Optimization & Repository Performance

## Objective

Phase 19.4 applies targeted query and repository optimizations only to hotspots measured in Phases 19.2 and 19.3. It preserves authority ownership, financial behavior, event contracts, API response contracts, and rollback/comparison posture.

## Selected Measured Bottlenecks

- `/api/health/db`: measured as a slow health probe.
- `/api/settlement-shadow/summary`: measured as a slow API hotspot through recent settlement shadow run sampling.
- `/api/credit-shadow/summary`: measured as a slow API hotspot through recent credit shadow run sampling.
- Credit shadow run listing: loaded all runs before applying filters in memory.

Outbox recent events, worker heartbeat recent records, and auth repository access remain measured candidates, but this phase did not change them because their current response shapes and write/read semantics require a narrower follow-up design.

## Optimizations

### Database Health Probe

The database health check no longer requests an exact count. It now performs a single-row `id` probe against `platform_users`, preserving the response contract while avoiding a count aggregation for a liveness check.

### Settlement Shadow Summary - Reverted

The settlement summary rewrite was re-measured after initially mixed results. Because the final correction measurement still showed regression, the change was reverted:

- full run, failure, and mismatch reads remain in place,
- readiness behavior remains unchanged,
- no index was added without native plan evidence.

The target is documented as unchanged until a safer optimization is available.

### Credit Shadow Summary - Reverted

The credit summary optimization was re-measured and showed repeatable regression. The change was reverted, preserving the previous behavior and API contract:

- full run, failure, and mismatch reads remain in place,
- filtering remains unchanged,
- no index was added without native plan evidence.

The target is documented as unchanged until a safer optimization is available.

### Credit Shadow Run Filtering - Reverted

Pushing credit shadow run filters and limits into the repository query also showed repeatable regression. The change was reverted and the target is unchanged for Phase 19.4.

## Before / After Methodology

Before values use Phase 19.3 measured bottleneck output. After values are collected by `npm run ops:query-optimization-report` against the running stack. Each optimized target reports:

- target name,
- before latency,
- after latency,
- improvement percentage,
- query count/context,
- rows returned context,
- behavior-change flag.

## Indexes

No migrations or indexes were added in this phase. Native plan access remains unavailable through current Supabase REST access, so index changes were intentionally deferred rather than guessed.

## Behavior Preservation

- No financial calculations changed.
- No settlement, ledger, or credit wallet logic changed.
- No authority, certification, promotion, rollback, or routing behavior changed.
- No event contracts changed.
- No API response contracts changed.
- No Redis caching or cross-request caching was introduced.

## Remaining Candidates

- Settlement and credit shadow summary reads need a different design because the first repository rewrites regressed under repeat measurement.
- Recent outbox events can be optimized after a dedicated lightweight event-summary contract or safe index plan is approved.
- Worker heartbeat reads can be optimized after active-heartbeat-only semantics are separated from historical heartbeat evidence.
- `src/domains/auth/auth.repository.ts` remains a repository hotspot and should be addressed with request-scoped permission/group loading reuse.

## Recommendation for Phase 19.5

Add a narrow, reviewed optimization pass for auth repository request-scoped reads and worker heartbeat active-state reads. Defer indexes until safe native `EXPLAIN` access or approved query-plan evidence is available.
