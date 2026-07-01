# ADR-024 - Auth Provider-Based Credential Verification

## Status

Accepted

## Context

The Auth Service must support multiple credential forms without coupling identity records to credential-specific verification logic.

## Decision

Credential verification is provider-based. Each credential type is verified through an explicit verifier contract, and every verifier returns the shared structured credential verification result.

Verifier results must not contain secret material. Verification emits audit/security evidence but does not create sessions or issue tokens in Phase 23.3.

## Consequences

- New credential types can be added without changing the identity aggregate.
- Authentication behavior can remain lifecycle-gated and auditable.
- Production verifier implementations remain deferred to a later phase.
