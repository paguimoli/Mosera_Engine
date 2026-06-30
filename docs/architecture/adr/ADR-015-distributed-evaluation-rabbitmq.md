# ADR-015 - Distributed Evaluation RabbitMQ

## Status

Accepted

## Context

Game Engine evaluation must scale across workers after an Official Certified Result exists. Evaluation batches are independent, idempotent, and retryable. Settlement must consume immutable evaluation records later, but Phase 22.6H cannot activate production game logic or Settlement integration.

## Decision

The Game Engine defines RabbitMQ-shaped contracts and routing keys for evaluation batch requests, starts, completions, failures, retry scheduling, dead-lettering, and worker heartbeats.

The local implementation remains in-memory by default. The publisher builds work item contracts and records diagnostic work. The consumer skeleton validates work items, models acknowledgement, retry, poison message handling, and dead-lettering, then simulates placeholder completion. External publishing is disabled unless explicitly enabled by a future approved phase.

## Consequences

Positive:

- Queue contracts are stable before production worker activation.
- Any future Game Engine instance can process any batch.
- Retry, dead-letter, and heartbeat evidence are modeled early.
- Financial platform behavior remains unchanged.

Tradeoffs:

- No production RabbitMQ consumer is active yet.
- Queue state is not persistent.
- Ticket reads and Game Module execution are deferred.
- Settlement events are not emitted.
