# ADR-023 - Auth Hybrid Token Model

## Status

Accepted

## Context

The platform needs JWT access tokens for local service enforcement and opaque reference tokens where revocation, introspection, or tighter server-side control is required. Refresh token rotation and signing key lifecycle need durable evidence before runtime issuance exists.

## Decision

The Auth Service token model supports JWT metadata, opaque reference tokens, refresh token rotation, revocation records, introspection records, signing key metadata, and JWKS descriptors. Phase 23.2 models these concepts only.

## Consequences

- Token issuance remains disabled until a later phase.
- Services can eventually validate JWTs locally.
- Opaque token references can support introspection and revocation.
- Signing keys are versioned for future JWKS rotation.
- Refresh token rotation is modeled before implementation.
