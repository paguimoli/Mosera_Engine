# ADR-005 - Game Engine Shared Schema Ownership

## Status

Accepted

## Decision

The Game Engine owns a dedicated PostgreSQL schema in the shared database, not a separate database yet.

## Rationale

A dedicated schema gives ownership boundaries without adding operational database complexity before deployment.

## Consequences

Future migrations must be scoped to `game_engine` and must not mutate Settlement, Ledger, Credit, wallet, or authority schemas.
