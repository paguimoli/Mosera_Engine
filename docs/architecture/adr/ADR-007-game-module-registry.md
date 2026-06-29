# ADR-007 - Game Module Registry

## Status

Accepted

## Context

The Game Engine needs a runtime composition layer that can discover deployed Game Modules, validate SDK compliance, expose diagnostics, and bind configured games to module versions without enabling production game logic.

## Decision

Game Modules are discovered automatically during Game Engine startup by scanning loaded assemblies for concrete `IGameModule` implementations with parameterless constructors.

The registry:

- Is the Game Engine source of truth for loaded modules.
- Refuses invalid module registration.
- Records rejected module evidence.
- Separates active, inactive, and production-ready modules.
- Creates versioned prospective game bindings.
- Requires service restart for newly deployed modules.

Runtime hot-plugging is not supported.

## Consequences

- Deployment remains deterministic and restart-based.
- Module validation is visible before production activation.
- Game bindings can be reviewed without mutating financial systems.
- Future production activation must add operator approval and persistence before enabling real games.
