# ADR-032 - Auth Zero-Downtime Migration

## Status

Accepted

## Context

Authentication migration must avoid forced downtime, permission loss, duplicate identities, session loss, and audit gaps.

## Decision

The Auth Service migration uses phased zero-downtime coexistence:

1. Deploy with no traffic.
2. Shadow validation.
3. Dual authentication.
4. Admin migration.
5. Internal service migration.
6. Player migration.
7. OAuth activation.
8. Legacy retirement.

Each phase has success criteria, rollback criteria, and an approval gate. Legacy auth remains available until retirement is approved.

## Consequences

- Migration can stop or roll back at each phase.
- Existing sessions and credentials remain valid during coexistence.
- Full runtime cutover is deferred to a later approved phase.
