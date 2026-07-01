# ADR-027 - Auth Policy-Based Sessions

## Status

Accepted

## Context

Auth Service sessions must support multiple identity and client types while preserving lifecycle, MFA, revocation, and risk controls.

## Decision

Sessions are policy-based. Session policy defines concurrency, idle timeout, absolute lifetime, MFA requirement, device trust placeholder, IP/geography placeholder, forced logout, revocation, and lifecycle validation.

## Consequences

- Session behavior can vary by identity, client, and risk policy.
- Production session creation remains gated until persistence, credential verification, and migration are approved.
