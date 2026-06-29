# ADR-011 - Validation Suite

## Status

Accepted

## Decision

Validation Suite is part of the Certification Suite and registers validators and benchmarks for distribution, frequency, pair, triplet, position, runs, regression, version comparison, performance, stress, and memory evidence.

## Rationale

Validation evidence must be produced consistently for certification packages. Keeping validation inside the certification boundary supports reproducible packages.

## Consequences

- Statistical algorithms are framework placeholders in Phase 22.6E.
- Future validators must emit structured results.
- Long-running validation execution remains deferred.
