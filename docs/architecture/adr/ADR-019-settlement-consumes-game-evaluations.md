# ADR-019: Settlement Consumes Game Evaluations

## Status

Accepted.

## Context

Game Modules evaluate game rules and emit immutable Evaluation Records. Settlement owns payout application and financial effects. The boundary between these systems must prevent Game Modules from posting financial transactions and prevent Settlement from re-evaluating game rules.

## Decision

Settlement will consume Game Engine Evaluation Records through a governed contract in a future phase. Evaluation Records are append-only Game Engine outputs with deterministic idempotency keys, outcome metadata, version metadata, draw identifiers, game identifiers, and ticket identifiers.

Settlement consumption remains disabled until an explicit activation gate is satisfied. The gate requires durable storage, immutable records, a completed evaluation run, approved game binding, approved module version, certified draw, settlement consumer approval, ready financial authorities, and passing settlement integration QA.

Cross-service integration must use contracts/events. Settlement must not write directly into Game Engine-owned record tables except through a future governed consumption status workflow.

## Consequences

- Settlement never evaluates game rules.
- Game Modules never perform financial posting.
- Evaluation Records can be replayed and audited independently from payout application.
- Settlement activation requires a future operator-approved phase.
