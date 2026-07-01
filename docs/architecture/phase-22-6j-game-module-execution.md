# Phase 22.6J - Game Module Execution Framework

## Purpose

Phase 22.6J connects the Evaluation Orchestrator to Game Modules through a safe in-memory execution framework. It proves the path from a certified draw shape, through an evaluation run and batch, into immutable evaluation records.

## Execution Flow

The framework executes:

1. Evaluation run and batch lookup.
2. Game binding and module version resolution.
3. Module lifecycle and configuration validation.
4. In-memory ticket batch read.
5. Ticket validation through the Game Module.
6. Ticket evaluation through the Game Module.
7. Immutable evaluation record construction.
8. Batch completion.
9. Run completion when all batches are completed.

Single-ticket validation failures are recorded as ticket-level failures and do not stop the batch.

## Components

- `GameModuleExecutionService`
- `ModuleResolver`
- `ModuleVersionResolver`
- `EvaluationExecutionContext`
- `ITicketReader`
- `InMemoryTicketReader`
- `EvaluationRecordBuilder`

## Diagnostics

New diagnostic endpoints expose execution state, module resolution state, and ticket reader state:

- `GET /api/game-engine/module-execution`
- `GET /api/game-engine/module-execution/{runId}`
- `GET /api/game-engine/module-resolution`
- `GET /api/game-engine/ticket-readers`
- `POST /api/game-engine/module-execution/run`

The POST endpoint is an admin placeholder and executes only in-memory reference data.

## Boundaries

This phase does not read tickets from the platform database, persist evaluation records, publish settlement events, post ledger entries, mutate credit, or activate any production game. Evaluation records are game outcomes, not financial transactions.

## Keno Reference Execution

The Keno module executes through the framework using deterministic in-memory tickets and a certified draw payload. The framework produces immutable records with ticket id, draw id, game id, module id, module version, evaluator version, paytable version, outcome, reason code, payout, metadata, and timestamp.

## Deferred Work

Production use requires persistent execution state, database ticket reads, replay tooling, operator controls, and settlement consumption.
