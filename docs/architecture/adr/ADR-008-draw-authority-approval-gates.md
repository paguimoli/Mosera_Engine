# ADR-008 - Draw Authority Approval Gates

## Status

Accepted

## Context

Game results can originate from different authority types: manual certified entry, official feeds, external RNG providers, supplier APIs, internal production PRNG, and internal test PRNG. These sources must be configured independently from games and must not become production sources without explicit readiness evidence.

## Decision

Draw Authorities are shared resources with version metadata, provider health, capabilities, lifecycle status, and approval status. Game binding assignment is prospective and must pass approval gates.

Production assignment requires production-ready status, valid provider health, required capabilities, non-retired state, and approval metadata. Internal Test PRNG can never be production assigned. Internal Production PRNG remains blocked until production approval evidence exists.

Manual Certified Entry may accept manual result evidence, but official result certification requires operator certification metadata.

## Consequences

- Draw source configuration remains independent from Game Modules.
- Placeholder providers can be tested without production activation.
- Settlement remains isolated from draw certification until a later phase.
- Correction/replacement workflows are explicitly deferred.
