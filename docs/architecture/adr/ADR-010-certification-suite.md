# ADR-010 - Certification Suite

## Status

Accepted

## Decision

The Game Engine owns a Certification Suite capable of producing structured certification evidence for game modules, draw generators, randomness providers, configuration, build metadata, and validation results.

## Rationale

Certification is an architectural capability. Building the evidence model into the service makes certification repeatable and auditable instead of a manual post-development artifact.

## Consequences

- Certification packages are structured objects in this phase.
- Archive/PDF generation is deferred.
- External laboratory automation is deferred.
