# ADR-016 - Keno Module Reference Implementation

## Status

Accepted

## Context

The Game Engine needs a real game-family module to prove the SDK, registry, fixtures, and diagnostics work with non-trivial game logic. Keno is suitable because it has generic rules, optional bullseye behavior, and several derived wager families.

## Decision

Implement `KENO_GENERIC` as a Game Module reference implementation. The module owns Keno validation and evaluation logic. It exposes supported wager types, configuration metadata, deterministic fixtures, and diagnostics through the existing Game Module registry.

The module remains non-production. Internal draw generation is disabled by default. Product-specific paytables, official feed integration, ticket reads, and settlement consumption remain deferred.

## Consequences

- The SDK now has a real game-family reference implementation.
- Hot Spot can be modeled later as product configuration, not hardcoded engine behavior.
- Settlement remains decoupled from game rules.
- Production readiness still requires approved paytables, official feed integration, persistence, benchmarking, and governed settlement consumption.
