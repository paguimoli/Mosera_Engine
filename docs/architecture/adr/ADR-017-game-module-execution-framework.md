# ADR-017 - Game Module Execution Framework

## Status

Accepted

## Context

The Evaluation Orchestrator can plan runs and batches, and Game Modules can evaluate tickets. The platform needs an execution layer that connects these parts without coupling settlement, ledger, credit, or product-specific logic to the Game Engine.

## Decision

Introduce a generic Game Module execution framework. The framework resolves modules through the registry, validates lifecycle and configuration, reads tickets through an abstraction, invokes module validation and evaluation, and builds immutable evaluation records.

The initial ticket reader is in-memory only. Evaluation records are held in memory for diagnostics. Settlement integration, ticket database reads, financial posting, and production persistence remain disabled.

## Consequences

- Game Modules can now execute through an orchestrated pipeline.
- Keno validates the full reference path without production activation.
- Settlement remains decoupled from game rules.
- Production launch still requires persistent records, database ticket reads, replay controls, and settlement consumption.
