# ADR-014 - Evaluation Orchestrator Batch Processing

## Status

Accepted

## Context

The Game Engine must evaluate tickets after an Official Certified Result exists. Settlement must not evaluate game rules. Future production evaluation needs distributed workers, checkpointing, retries, and immutable evaluation records, but Phase 22.6G cannot wire production RabbitMQ or Settlement consumption.

## Decision

The Game Engine owns an Evaluation Orchestrator with in-memory state for this phase.

The orchestrator creates Evaluation Runs, deterministic Evaluation Batches, Evaluation Checkpoints, and immutable Evaluation Records. Batches are independent and retryable. Work item and completion/failure event contracts are defined for future RabbitMQ processing, but production queue wiring remains disabled.

Evaluation records are uniquely keyed by draw, ticket, game, module, module version, and evaluation version. Duplicate attempts return the existing record with a structured duplicate status.

## Consequences

Positive:

- Settlement remains isolated from game-rule evaluation.
- Batch boundaries are deterministic and suitable for future distributed processing.
- Checkpoints and idempotency rules are defined before production traffic.
- Diagnostics are available without financial mutation.

Tradeoffs:

- Evaluation state is not durable yet.
- Ticket reads are placeholder inputs.
- Production RabbitMQ workers and Settlement consumption are deferred.
- Replay and correction workflows require a later governed design.
