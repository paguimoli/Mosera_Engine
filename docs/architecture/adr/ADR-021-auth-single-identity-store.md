# ADR-021 - Auth Single Identity Store

## Status

Accepted

## Context

The platform needs identities for admins, players, agents, operators, API clients, service accounts, and PAM users. Splitting identity state across business domains would make authorization, audit, federation, and session migration harder to reason about.

## Decision

The Auth Service owns a single global identity store. Business domains reference identities by immutable `IdentityId` or `LoginId`, but do not own identity lifecycle, credentials, sessions, tokens, or security relationships.

## Consequences

- Login ID uniqueness is global.
- Login ID is immutable after creation.
- Auth owns identity lifecycle transitions.
- Business hierarchy remains outside Auth.
- Migration from current platform auth requires explicit mapping and rollback gates.
