# ADR-044 - Outcome Authority Architecture Principles v1

## Status

Accepted

## Context

P0-005 freezes permanent architectural principles for outcome, math,
governance, certification, settlement, and financial authority. These
principles must survive future decomposition, game expansion, and regulator
review.

## Decision

Mosera adopts these architecture principles:

1. Outcome Authority never knows money.
2. Math Authority never generates randomness.
3. RTP is never controlled by RNG.
4. Settlement never changes outcomes.
5. Ledger is immutable financial truth.
6. Every authority produces signed and hash-linked evidence.
7. Production artifacts are immutable and versioned.
8. No production placeholders are allowed in authority paths.
9. Simulation can never be production authority.

## Rationale

These principles prevent category errors that commonly weaken gaming platforms:
RNG paths trying to manage economics, settlement reinterpreting outcomes,
financial systems embedding game logic, and simulation tooling leaking into
production.

## Consequences

- Production readiness checks must fail closed if an authority path contains
  placeholder status.
- Corrections and replays create superseding evidence instead of mutation.
- Future services must preserve signed/hash-linked evidence contracts.
- Authority implementations may evolve, but these principles remain stable.
