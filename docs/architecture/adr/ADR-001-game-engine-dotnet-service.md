# ADR-001 - Game Engine .NET Service

## Status

Accepted

## Decision

The Game Engine starts as a dedicated .NET service.

## Rationale

Game evaluation, draw scheduling, provider integrations, and module SDK boundaries benefit from a strongly typed service boundary from the beginning.

## Consequences

The service has its own solution, projects, Docker image, and schema ownership. Existing Settlement, Ledger, and Credit authority behavior remains unchanged.
