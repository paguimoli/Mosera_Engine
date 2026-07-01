# ADR-028 - Auth JWT/Opaque Token Strategy

## Status

Accepted

## Context

Services need locally enforceable claims, while some token use cases require centralized introspection and revocation control.

## Decision

Auth Service uses a hybrid token strategy:

- JWT access tokens for locally verifiable claims.
- Opaque reference tokens for introspection-controlled use cases.

Access tokens are short-lived. Refresh tokens are optional and rotation-aware. Token issuance remains disabled until signing keys, persistence, revocation, and QA are approved.

## Consequences

- Services can enforce policies locally once token validation is implemented.
- Opaque tokens can be used where revocation/introspection control is required.
- Runtime signing and introspection are explicit future work.
