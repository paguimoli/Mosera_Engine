# Phase 22.6F - Draw Scheduler & Draw Lifecycle Framework

## Purpose

Phase 22.6F adds the Game Engine draw scheduler and draw lifecycle framework. It establishes schedule definitions, lifecycle state diagnostics, cutoff handling, missed draw detection, and recovery placeholders.

This phase does not activate production games, production RNG, settlement integration, official feed polling, or RabbitMQ draw processing.

## Scheduler Model

The scheduler supports:

- Fixed interval schedules for Keno-style games.
- Fixed daily draw times for Pick-style games.
- Time zone-aware schedule metadata.
- Sales open, cutoff, close, draw, and result expected timestamps.
- Missed draw detection.
- Manual recovery markers.

Scheduler state is in-memory only in this phase.

## Lifecycle States

Lifecycle diagnostics support:

- `Scheduled`
- `SalesOpen`
- `SalesClosed`
- `AwaitingResult`
- `ResultSubmitted`
- `Certified`
- `EvaluationPending`
- `EvaluationInProgress`
- `EvaluationCompleted`
- `SettlementReady`
- `Cancelled`
- `Failed`
- `ManualReviewRequired`

Existing compatibility states remain available where already used.

## Draw Authority Interaction

Draw schedules reference existing Draw Authority abstractions.

Internal generated authorities become eligible only after sales close. Official-feed and manual-certified schedules move toward awaiting-result/manual-review states after sales close. Production activation remains disabled.

The scheduler never pre-generates future internal draw results.

## Diagnostics

The Game Engine exposes:

- `GET /api/game-engine/draw-schedules`
- `GET /api/game-engine/draw-schedules/{id}`
- `GET /api/game-engine/draw-lifecycle`
- `GET /api/game-engine/draw-lifecycle/{drawId}`
- `GET /api/game-engine/scheduler-status`
- `POST /api/game-engine/draw-schedules/{id}/preview`
- `POST /api/game-engine/draw-lifecycle/{drawId}/mark-missed`

POST endpoints are admin-boundary placeholders and operate only on in-memory diagnostics.

## Exit Criteria

- Schedule previews are available.
- Lifecycle diagnostics are available.
- Sales after cutoff are blocked.
- Internal draw generation is not eligible before sales close.
- Official/manual result games wait for result after close.
- Missed draw manual recovery marker exists.
- No production activation or settlement integration is introduced.
