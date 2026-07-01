# Phase 22.6K - Persistent Evaluation Storage & Database Ticket Reader

## Objective

Phase 22.6K adds persistent evaluation storage and a production-shaped ticket reader abstraction to the Game Engine skeleton. The execution pipeline remains the same: modules are resolved, eligible tickets are read, records are built, and settlement/financial effects remain disabled.

## Implemented Storage Boundary

- `EvaluationPersistenceService` owns replay-safe record persistence and checkpoints.
- `InMemoryEvaluationRecordRepository` provides append-only repository behavior for the skeleton service.
- `ImmutableEvaluationRecord` now carries a deterministic idempotency key.
- Duplicate record inserts return the existing immutable record.
- Query services support records by id, run, draw, ticket, and batch.
- Checkpoints persist batch cursor, processed count, failed count, retry count, status, and timestamps.

## Ticket Reader

`DatabaseTicketReader` implements the existing `ITicketReader` batch and range methods and adds direct cursor reads for future database-backed execution. It is deterministic, read-only, and does not filter based on settlement state.

## Replay Rules

- Completed records are not recreated.
- Duplicate execution returns existing records.
- Resume of completed work creates zero records.
- Replay metadata is exposed through storage diagnostics and checkpoints.

## Diagnostics APIs

- `GET /api/game-engine/evaluation-records`
- `GET /api/game-engine/evaluation-records/{id}`
- `GET /api/game-engine/evaluation-runs/{id}/records`
- `GET /api/game-engine/evaluation-checkpoints`
- `POST /api/game-engine/evaluation-runs/{id}/resume`

All responses keep `settlementIntegrationEnabled=false` and `financialPostingEnabled=false` where applicable.

## Deferred Work

- Durable database implementation of the repository.
- Settlement consumer activation.
- Operator replay tooling.
- Long-term evaluation archive and retention policy.
