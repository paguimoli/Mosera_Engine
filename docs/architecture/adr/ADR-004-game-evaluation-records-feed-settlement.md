# ADR-004 - Game Evaluation Records Feed Settlement

## Status

Accepted

## Decision

The Game Engine produces immutable evaluation records. Settlement consumes evaluation records.

## Rationale

This separates game outcome evaluation from financial settlement execution.

## Consequences

Evaluation records require immutable metadata, version stamps, idempotency, and traceability to certified draw results.
