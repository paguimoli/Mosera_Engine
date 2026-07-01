# ADR-030 - Auth Service-to-Service Trust

## Status

Accepted

## Context

Extracted services need a consistent trust model that avoids long-lived shared secrets and supports local policy enforcement.

## Decision

Service-to-service trust uses OAuth2 client credentials with optional future mTLS binding. Service tokens are short-lived, scope-constrained, and audit-required.

Client secrets and certificates are represented as metadata references only.

## Consequences

- Services can eventually authenticate through the Auth Service instead of implicit network trust.
- Runtime enforcement remains deferred until token issuance and service validation are approved.
