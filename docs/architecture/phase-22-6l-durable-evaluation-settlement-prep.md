# Phase 22.6L - Durable Evaluation Storage & Settlement Consumer Preparation

## Objective

Phase 22.6L prepares durable evaluation storage and the governed Settlement consumer path. It does not activate Settlement consumption, publish Settlement events, post Ledger entries, update Credit, move money, or activate production games.

## Durable Storage Foundation

The additive SQL draft `services/game-engine/database/002_durable_evaluation_storage.sql` defines:

- `game_engine.evaluation_runs`
- `game_engine.evaluation_batches`
- `game_engine.evaluation_records`
- `game_engine.evaluation_checkpoints`

Evaluation Records include a unique idempotency key, draw/ticket/run/batch/game indexes, outcome metadata, version metadata, and future Settlement consumer status fields. The draft includes update/delete prevention triggers for append-only enforcement.

Runtime repository contracts are production-shaped:

- `IEvaluationRunRepository`
- `IEvaluationBatchRepository`
- `IEvaluationRecordRepository`
- `IEvaluationCheckpointRepository`
- `ISettlementEvaluationReadModel`

The current runtime still uses in-process skeleton storage until durable database wiring is approved.

## Settlement Preparation

`SettlementEvaluationReadService` exposes only settlement-ready records:

- completed evaluation runs only
- evaluable outcomes only
- invalid/rejected records excluded
- consumed records excluded by default
- idempotency, payout, reason, draw, game, ticket, and version metadata included

`SettlementConsumerActivationGate` is disabled by default and reports the future requirements before any activation can occur.

## Diagnostics

- `GET /api/game-engine/evaluation-storage-status`
- `GET /api/game-engine/settlement-readiness`
- `GET /api/game-engine/settlement-evaluation-records`
- `GET /api/game-engine/settlement-consumer-status`
- `POST /api/game-engine/settlement-consumer/activate`

The activation endpoint always rejects in this phase.

## Deferred

- Durable database repository implementation.
- Settlement consumer activation.
- Settlement event publishing.
- Consumed-status governance.
- Re-evaluation and resettlement policy.
