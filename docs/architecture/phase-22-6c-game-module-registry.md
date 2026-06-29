# Phase 22.6C - Game Module Registry & Game Binding

## Purpose

Phase 22.6C adds the Game Module Registry as the runtime composition layer for the Game Engine. The registry discovers compiled game modules at service startup, validates SDK compliance, records structured registration results, and exposes prospective game bindings.

This phase does not add production RNG, production game logic, ticket evaluation processing, financial settlement behavior, or RabbitMQ game processing.

## Registry Responsibilities

- Discover deployed assemblies that implement `IGameModule`.
- Validate required SDK interfaces, manifests, version metadata, health checks, default configuration, and lifecycle gate evidence.
- Register valid modules and preserve rejected module evidence.
- Expose registered, inactive, active, and production-ready modules.
- Report registry health with reasons.
- Act as the Game Engine source of truth for module diagnostics.

Modules are discovered during startup only. Runtime hot-plugging is intentionally unsupported; loading a newly deployed module requires a service restart.

## Game Binding

A `GameBinding` links a configured game to:

- Game module id
- Module version
- Draw authority
- Draw schedule
- Settlement trigger policy
- Default configuration
- Game-specific overrides

Bindings are versioned and prospective. Historical draws remain tied to the binding version that created them. Phase 22.6C exposes binding diagnostics only and does not activate production play.

## Version Selection

The registry supports:

- `LatestApproved`
- `SpecificVersion`
- `StagedRolloutPending` as a reserved future mode

Because current modules are placeholders, no module is production ready.

## Diagnostics

Added endpoints:

- `GET /api/game-engine/modules`
- `GET /api/game-engine/modules/{id}`
- `GET /api/game-engine/modules/{id}/versions`
- `GET /api/game-engine/game-bindings`
- `GET /api/game-engine/game-bindings/{id}`
- `GET /api/game-engine/registry-status`

## Current State

- `HOT_SPOT` is registered as `Development`, healthy, inactive, and not production ready.
- `TEST_MODULE` is registered as `InternalTesting`, healthy, inactive, and not production ready.
- Default prospective bindings are created for diagnostics only.

## Exit Criteria

- Registry startup discovery works.
- SDK enforcement rejects invalid modules.
- Duplicate module id/version evidence is covered by tests.
- Game bindings validate supported game type, wager type, draw authority, and draw schedule.
- Existing financial authorities remain unchanged and certified.
