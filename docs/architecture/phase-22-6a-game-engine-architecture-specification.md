# Phase 22.6A - Game Engine Architecture Specification

## Scope

Phase 22.6A creates the initial .NET Game Engine service skeleton and captures approved architecture decisions only.

This phase does not implement production RNG, settlement changes, production game logic, financial behavior, or authority routing changes.

## Approved Architecture

The platform uses a Game Supplier + Platform model. The Game Engine owns game-specific math, ticket validation, draw scheduling, draw generation abstractions, and immutable evaluation records.

Each game has a configured Draw Authority. Draw Authorities are shared resources, approved before production use, versioned independently, and assigned prospectively to games. Authority assignment changes are never retroactive.

A draw may receive multiple submitted results. Exactly one submission may become the Official Certified Result. Manual Certified Result entry is supported, and one authorized operator may certify manual results.

Settlement does not own game math. Game Engine produces immutable evaluation records, and Settlement consumes those records.

## Service Skeleton

The new service lives under `services/game-engine/` and uses the current .NET target used by existing services.

Projects:

- `GameEngine.Api`
- `GameEngine.Application`
- `GameEngine.Domain`
- `GameEngine.Infrastructure`
- `GameEngine.Modules`
- `GameEngine.Domain.Tests`
- `GameEngine.Application.Tests`
- `GameEngine.Modules.Tests`

## Game Modules

Game Modules own game-specific validation, draw generation, and evaluation logic. The skeleton includes placeholder modules:

- `HotSpot`
- `TestModule`

Both are non-production skeleton modules.

Lifecycle:

1. Development
2. Internal Testing
3. QA Certified
4. Approved
5. Production Active
6. Retired

## PRNG And Draw Generation

PRNG infrastructure is shared inside the Game Engine and separate from Draw Generators.

Supported future provider strategies:

- Internal non-reproducible production CSPRNG
- Deterministic seed-based test PRNG
- External RNG providers
- Official feeds
- Manual certified entry

Internally generated Keno-style results are generated only after sales close. Future outcomes are not pre-generated.

## Evaluation

Game Engine pulls eligible tickets after draw certification. Evaluation is checkpoint-based and resumable. Batches are queue-driven through RabbitMQ and may be distributed across a horizontal Game Engine cluster.

Ticket evaluation order is not guaranteed.

## Version Metadata

The following version metadata must be stored immutably:

- Game module version
- Draw generator version
- Evaluator version
- Paytable version
- Game definition version
- PRNG provider version
- Draw authority version

## API Boundary

Business workflows are event-driven. APIs are limited to health, readiness, diagnostics, admin queries, and controlled operations.

Skeleton endpoints:

- `GET /health`
- `GET /ready`
- `GET /api/game-engine/status`
- `GET /api/game-engine/modules`
- `GET /api/game-engine/draw-authorities`
- `GET /api/game-engine/evaluation-runs`
- `POST /api/game-engine/evaluation-runs/{id}/retry`
- `POST /api/game-engine/draw-authorities/{id}/approve`
- `POST /api/game-engine/manual-results`

Admin authentication is represented by an explicit placeholder boundary. Production auth integration is deferred.

## Events

Inbound contracts:

- `draw.certified`
- `ticket.sales.closed`
- `game.definition.updated`
- `draw.authority.assignment.changed`

Outbound contracts:

- `game.draw.scheduled`
- `game.draw.generated`
- `game.draw.result.submitted`
- `game.draw.certified`
- `game.evaluation.started`
- `game.evaluation.batch.completed`
- `game.evaluation.completed`
- `game.evaluation.failed`
- `game.ticket.evaluated`

Phase 22.6A defines event contract classes only. Production messaging is not wired.

## Data Ownership

Game Engine owns a PostgreSQL schema named `game_engine` in the shared database. It does not use a separate database yet.

The schema draft is located at:

- `services/game-engine/database/001_game_engine_schema_draft.sql`

The draft is additive and is not applied automatically.

Schema design rules:

- Certified draw results are immutable.
- Evaluation records are immutable.
- Authority assignment history is prospective only.
- Version metadata is required.
- Exactly one Official Certified Result may exist per draw.

## Docker Integration

`game-engine` is added to Docker Compose as a buildable service on port `5500`, with a simple health check.

It is not required by existing financial QA paths.

## Non-Goals

- No production RNG.
- No production game logic.
- No settlement integration.
- No financial calculations.
- No authority routing changes.
- No game supplier integration.
- No regulatory certification implementation.

## Phase 22.6B Recommendation

Phase 22.6B should define the Game Module SDK in detail, including contract test expectations, deterministic test fixtures, module packaging, configuration validation, and lifecycle approval gates.
