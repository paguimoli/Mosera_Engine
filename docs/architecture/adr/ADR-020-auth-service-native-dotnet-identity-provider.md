# ADR-020 - Auth Service Native .NET Identity Provider

## Status

Accepted

## Context

The platform needs a native Authentication Service that can support admins, players, agents, operators, API clients, service accounts, and PAM users without fragmenting identity across multiple services. Existing platform authentication must remain unchanged while the architecture is specified.

## Decision

Create a native .NET Auth Service that acts as both Identity Service and Authorization Server. The service will own a single global identity store, immutable Login IDs, multiple credentials per identity, optional passwords, identity lifecycle state, memberships, sessions, tokens, OAuth clients, service accounts, API clients, security relationships, and authentication audit events.

Authorization will use a hybrid model: RBAC, claims, and policies. Auth is the policy authority, but services enforce policies locally. Service trust will use OAuth2 client credentials with optional mTLS. Token strategy will support JWT access tokens and opaque reference tokens. OAuth2/OpenID Connect provider behavior is required in future phases but is not implemented in Phase 23.1.

## Consequences

- Auth becomes the future source of truth for identity and security relationships.
- Product and financial domains keep business ownership.
- Existing authentication remains unchanged until a later migration phase.
- Future services can rely on a consistent identity, token, and policy model.
- Production login, token issuance, password handling, and OAuth runtime remain deferred.

## Non-Goals

- No production authentication implementation.
- No migration of current users.
- No token issuance.
- No password verification.
- No OAuth runtime.
- No changes to Settlement, Ledger, Credit, Game Engine, or current platform auth.
