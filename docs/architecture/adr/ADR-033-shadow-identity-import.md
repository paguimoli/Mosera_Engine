# ADR-033 - Shadow Identity Import

## Status

Accepted

## Context

The platform needs evidence that existing identities can migrate into the Auth Service before any production authentication behavior changes. The first real migration tooling must inspect current identity data without changing any row or issuing any credential, session, or token.

## Decision

Implement shadow identity import as read-only validation tooling.

The Auth Service maps legacy platform identities into deterministic in-memory identity projections, validates conflicts and blockers, and produces a JSON migration readiness report. The default runtime source is non-persistent until a production read-only adapter is explicitly wired.

The shadow import path must never:

- insert, update, or delete data;
- authenticate users;
- create sessions;
- issue tokens;
- modify legacy auth behavior.

## Consequences

- Operators can review migration readiness before cutover.
- Repeated validation reports are deterministic for the same source snapshot.
- Migration blockers are visible before any import exists.
- Production database wiring remains a separate, reviewable implementation step.
