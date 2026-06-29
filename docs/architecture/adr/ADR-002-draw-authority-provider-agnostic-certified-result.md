# ADR-002 - Draw Authority Provider-Agnostic Certified Result

## Status

Accepted

## Decision

Each game uses a configured Draw Authority as source of truth. Results may come from internal PRNG, external RNG providers, official feeds, or manual certified entry.

## Rationale

Different games and jurisdictions may require different result authorities while sharing one certification model.

## Consequences

Draw Authorities are versioned, approved before production use, and assigned prospectively. A draw may have multiple submitted results, but only one Official Certified Result.
