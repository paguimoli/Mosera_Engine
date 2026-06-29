# ADR-006 - Game Module SDK Contract

## Status

Accepted

## Decision

Every Game Module must implement the shared Game Module SDK contract and pass reusable contract tests before it can be considered for production readiness.

## Rationale

Game Modules own game-specific validation, draw generation, evaluation, paytable interpretation, and game math. A shared SDK and contract test suite keeps those modules independently versioned while preserving consistent Game Engine orchestration.

## Consequences

Modules must provide structured manifests, validation results, evaluation outputs, version metadata, health checks, and deterministic fixtures. Production readiness is gated by lifecycle status and contract compliance, but no admin approval workflow is implemented in this phase.
