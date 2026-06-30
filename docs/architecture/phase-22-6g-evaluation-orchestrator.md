# Phase 22.6G - Evaluation Orchestrator & Batch Processing Framework

## Objective

Phase 22.6G adds the Game Engine evaluation orchestration framework without enabling production game evaluation, RabbitMQ batch processing, or Settlement consumption.

The framework plans in-memory evaluation runs after an Official Certified Result exists, creates deterministic batches, tracks checkpoints, models retryable distributed work, and produces immutable evaluation record evidence suitable for later Settlement integration.

## Scope

Implemented framework components:

- EvaluationRun domain and lifecycle status.
- EvaluationBatch domain and retry status.
- EvaluationRecord idempotency model.
- EvaluationOrchestrator.
- BatchPlanner.
- BatchCheckpointService.
- EvaluationProgressService.
- Distributed work item and completion/failure event contracts.
- Diagnostics and placeholder admin APIs.

Deferred items:

- Persistent evaluation storage.
- Production RabbitMQ batch processing.
- Ticket database read integration.
- Settlement consumption integration.
- Evaluation replay and correction workflow.

## Lifecycle

Evaluation may be planned only when the request has:

- An Official Certified Result identifier.
- A valid Game Binding.
- A valid Game Module and module version.
- A draw lifecycle state that permits evaluation.
- A non-negative eligible ticket count.

Valid runs move through Pending, Planning, Planned, InProgress, PartiallyCompleted, Completed, Failed, Cancelled, RetryPending, and ManualReviewRequired states.

Evaluation batches move through Pending, Claimed, InProgress, Completed, Failed, RetryPending, Skipped, and Cancelled states.

## Batch Planning

Batch planning uses a game-specific batch size when supplied and falls back to the global default batch size of 100. Boundaries are deterministic and independent, which allows future queue-driven distributed execution without requiring strict ticket ordering.

Current ticket counts are placeholder inputs. No ticket database integration exists in this phase.

## Checkpointing and Resume

Each batch receives a checkpoint containing:

- Run id.
- Batch id.
- Ticket range or cursor.
- Status.
- Processed count.
- Failed count.
- Retry count.
- Last processed marker.
- Created and updated timestamps.

Completed batches are modeled as safe to skip, failed and retry-pending batches are eligible for retry, and duplicate evaluation attempts are blocked by the evaluation record idempotency key.

## Idempotency

Evaluation records are uniquely keyed by:

- Draw id.
- Ticket id.
- Game id.
- Game Module id.
- Game Module version.
- Evaluation version.

Duplicate attempts return the existing record with a structured duplicate status. Records include settlement facts that explicitly show they were not financially applied in this phase.

## Diagnostics

The Game Engine exposes:

- `GET /api/game-engine/evaluation-runs`
- `GET /api/game-engine/evaluation-runs/{id}`
- `GET /api/game-engine/evaluation-runs/{id}/batches`
- `GET /api/game-engine/evaluation-batches/{id}`
- `GET /api/game-engine/evaluation-progress/{runId}`
- `GET /api/game-engine/evaluation-orchestrator-status`
- `POST /api/game-engine/evaluation-runs/plan`
- `POST /api/game-engine/evaluation-runs/{id}/start`
- `POST /api/game-engine/evaluation-runs/{id}/retry`
- `POST /api/game-engine/evaluation-batches/{id}/retry`

Placeholder admin endpoints are in-memory only and do not trigger Settlement, Ledger, Credit, RabbitMQ, or financial mutation.

## Exit Criteria

Phase 22.6G is complete when the Game Engine can build, application tests pass, evaluation diagnostics respond, planning and retry are safe and in-memory, and the certified financial platform remains unchanged.
