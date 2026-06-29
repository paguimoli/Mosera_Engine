# ADR-003 - Game Modules Own Game Math

## Status

Accepted

## Decision

Game Modules own game-specific validation, draw generation, and evaluation logic.

## Rationale

Game math changes independently by game and must be versioned, certified, and retired without changing financial services.

## Consequences

The Game Engine provides a shared SDK and infrastructure. Settlement consumes evaluation records instead of embedding game math.
