# ADR-031 - Auth Coexistence Strategy

## Status

Accepted

## Context

The platform already has authoritative Next.js authentication. The native Auth Service is being prepared without disrupting existing users, sessions, roles, or financial operations.

## Decision

Existing platform authentication remains authoritative until explicit migration approval. Auth Service migration proceeds through coexistence, shadow validation, dual authentication checks, and controlled cutover phases.

The compatibility layer models legacy session validation, legacy token validation, legacy user lookup, migration bridge behavior, feature flags, and diagnostics.

## Consequences

- The Auth Service can be validated without production traffic.
- Legacy authentication can remain available for rollback.
- Migration execution remains blocked until approvals and runtime QA exist.
