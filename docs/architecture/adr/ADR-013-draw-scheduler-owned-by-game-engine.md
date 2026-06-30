# ADR-013 - Draw Scheduler Owned by Game Engine

## Status

Accepted

## Decision

The Game Engine owns draw scheduling and lifecycle state for configured games. Schedules bind prospective game configuration to draw authority, cutoff, close, result expectation, and recovery policy metadata.

## Rationale

Draw lifecycle state determines when sales close, when internal generation may become eligible, when official/manual results are expected, and when evaluation can eventually begin. Keeping this lifecycle inside the Game Engine avoids leaking draw-specific state into settlement or financial domains.

## Consequences

- Scheduler state is in-memory during the framework phase.
- Production scheduler activation requires a future approval phase.
- Settlement consumes only future official certified results and is not wired in this phase.
- Official feed polling and cancellation/correction workflows remain deferred.
