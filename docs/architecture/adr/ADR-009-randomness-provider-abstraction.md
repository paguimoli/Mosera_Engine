# ADR-009 - Randomness Provider Abstraction

## Status

Accepted

## Decision

Randomness is a Game Engine infrastructure capability exposed through provider interfaces. Production and test PRNG providers are separate implementations with separate metadata and capabilities.

## Rationale

Certification requires provider identity, version, health, and capability evidence. Separating production and deterministic test providers prevents test repeatability requirements from leaking into production draw generation.

## Consequences

- Production provider approval remains explicit.
- Test PRNG is deterministic and never production-assignable.
- Future hardware or external RNG providers can be added behind the same contract.
