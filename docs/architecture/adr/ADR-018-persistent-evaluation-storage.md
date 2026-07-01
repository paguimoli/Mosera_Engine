# ADR-018: Persistent Evaluation Storage

## Status

Accepted.

## Context

The Game Engine evaluation pipeline can resolve modules, read tickets, execute a reference Keno module, and produce immutable evaluation records. Phase 22.6K adds the storage boundary needed before any future settlement consumer can rely on evaluation output. This phase must remain evidence-only and must not post financial effects.

## Decision

Evaluation output is stored through a dedicated evaluation record repository. Records are append-only and keyed by a deterministic idempotency key composed from draw, ticket, game, module, module version, and evaluator version. Duplicate inserts return the original record and do not overwrite metadata, amounts, outcomes, or timestamps.

The ticket reader abstraction remains unchanged for execution. A `DatabaseTicketReader` implements the existing batch and range reads and exposes cursor reads directly for future database-backed execution. It reads only tickets eligible for the current run and does not apply settlement filtering.

Evaluation checkpoints are persisted separately from the orchestrator's planning state. Checkpoints track run, batch, cursor, processed count, failed count, retry count, status, and timestamps. Resume operations continue from persisted batch state and return existing records for completed work.

## Consequences

- Replay is safe because completed records are not recreated.
- Historical records remain immutable in the repository boundary.
- Settlement integration remains explicitly disabled.
- Financial posting remains explicitly disabled.
- The current implementation is in-memory for the skeleton service; durable database backing is deferred.
