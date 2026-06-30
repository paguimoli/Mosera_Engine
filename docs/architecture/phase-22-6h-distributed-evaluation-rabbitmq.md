# Phase 22.6H - Distributed Evaluation Processing & RabbitMQ Integration

## Objective

Phase 22.6H adds the distributed evaluation processing infrastructure for the Game Engine. It connects the Evaluation Orchestrator to queue-shaped batch processing contracts while keeping execution in-memory and diagnostic-only.

This phase does not implement production game logic, ticket database reads, Settlement integration, production RabbitMQ consumers, or financial mutations.

## Queue Contracts

The Game Engine defines routing constants for:

- `game.evaluation.batch.requested`
- `game.evaluation.batch.started`
- `game.evaluation.batch.completed`
- `game.evaluation.batch.failed`
- `game.evaluation.batch.retry_scheduled`
- `game.evaluation.batch.dead_lettered`
- `game.evaluation.worker.heartbeat`

Evaluation work items and events carry run id, batch id, draw id, game id, Game Module id and version, evaluation version, attempt number, correlation id, causation id, idempotency key, and creation timestamp.

## Publisher

The batch publisher builds work items from planned Evaluation Batches. External RabbitMQ publishing is guarded by `GAME_ENGINE_EVALUATION_RABBITMQ_PUBLISHING_ENABLED` and remains disabled by default. Current endpoint behavior records diagnostic in-memory work items only.

## Consumer Skeleton

The consumer skeleton validates work items, detects poison messages, marks batches in progress, simulates placeholder processing, marks batches completed, and emits completion evidence. It does not execute game module logic and does not read tickets.

## Retry and DLQ

The retry model defines max attempts, retry eligibility, retry scheduled events, dead-letter events, and poison message detection. Dead-letter review is an in-memory operator placeholder and performs no destructive queue operation.

## Worker Heartbeats

Worker heartbeat events track:

- Worker id.
- Instance id.
- Service version.
- Processed batch count.
- Failed batch count.
- Last heartbeat timestamp.
- Worker status.

Supported statuses are Starting, Idle, Processing, Degraded, Stopping, and Failed.

## Diagnostics

The Game Engine exposes:

- `GET /api/game-engine/evaluation-queues`
- `GET /api/game-engine/evaluation-workers`
- `GET /api/game-engine/evaluation-worker-heartbeats`
- `GET /api/game-engine/evaluation-dead-letter`
- `GET /api/game-engine/evaluation-processing-status`
- `POST /api/game-engine/evaluation-runs/{id}/publish-batches`
- `POST /api/game-engine/evaluation-batches/{id}/requeue`
- `POST /api/game-engine/evaluation-dead-letter/{id}/review`

All admin endpoints remain safe, in-memory, and financially inert.

## Exit Criteria

Phase 22.6H is complete when RabbitMQ-shaped contracts, publisher, consumer skeleton, retry/DLQ model, worker heartbeat model, diagnostics, tests, and QA exist while production game logic, ticket integration, Settlement integration, and financial behavior remain unchanged.
