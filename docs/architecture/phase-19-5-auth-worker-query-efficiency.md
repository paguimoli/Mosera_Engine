# Phase 19.5 - Auth Repository and Worker Heartbeat Query Efficiency

## Objective

Phase 19.5 optimizes only measured auth repository and worker heartbeat hotspots. It does not change authentication semantics, RBAC behavior, session lifetime, worker execution, authority ownership, routing, or financial behavior.

## Selected Bottlenecks

The selected targets were measured before implementation from the running app container:

| Target | Before | Scope |
| --- | ---: | --- |
| Auth session context | 1290.875 ms | `/api/auth/me` authorization context loading |
| Auth permission check | 1191.812 ms | `/api/auth/check-permission?permission=system.admin` |
| Worker observability heartbeats | 1355.106 ms | `/api/operations/workers` heartbeat reporting |

The remaining outbox recent-event read was left unchanged because the public and operations contracts still require full event payload visibility.

## Optimizations

Auth context loading now uses a consolidated authorization repository loader. The loader reads group memberships once, loads groups and permission assignments together, then loads permissions by the resulting permission ids. Existing `findGroupsForUser` and `findPermissionsForUser` behavior remains available for callers that need those separate operations.

Worker observability now separates fresh heartbeat reads from bounded stale heartbeat evidence. Fresh active workers are queried with an explicit heartbeat freshness window, while stale heartbeat history remains visible through a bounded evidence list.

## Behavior Preservation

The phase preserves:

- Session token validation and revocation behavior.
- User status checks.
- Group and permission response shapes.
- `system.admin` permission behavior.
- Worker heartbeat audit evidence.
- Settlement, Ledger, and Credit authority/certification state.
- Financial records and accounting data.

No cross-request cache, Redis cache, index, migration, schema change, business routing change, or financial mutation is introduced.

## Reverted Attempts

No attempted Phase 19.5 optimization was kept if it regressed during validation. Outbox recent event payload narrowing was not attempted because it would risk changing the reporting contract.

## Operations

Run:

```sh
npm run ops:auth-worker-query-efficiency-report
```

The report returns optimized targets, before/after latency, query counts where available, result counts, files touched, reverted attempts, and remaining slow targets.

## QA

Run:

```sh
npm run qa:auth-worker-query-efficiency
```

The QA validates auth flow, session validation, permission checks, unchanged authority baseline, fresh-vs-stale worker heartbeat reporting, stale heartbeat evidence visibility, measurement output, and absence of financial mutations.

## Recommendation for Phase 19.6

Measure the remaining outbox recent-event read and authentication write paths independently before selecting additional optimization candidates. Keep outbox payload contracts unchanged unless a separate API contract change is approved.
