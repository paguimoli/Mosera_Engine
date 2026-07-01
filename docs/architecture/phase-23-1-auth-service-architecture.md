# Phase 23.1 - Authentication Service Architecture Specification

Phase 23.1 defines the native .NET Authentication Service architecture. It does not implement production login, token issuance, password handling, OAuth runtime behavior, platform auth migration, or service wiring.

## Scope

The Auth Service is the Identity and Authorization Server for the platform. It owns identities for admins, players, agents, operators, API clients, service accounts, and PAM users. The service owns security relationships only; product, wallet, settlement, ledger, credit, game, and operational business state remain owned by their existing domains.

## Approved Architecture

- Single global identity store.
- Immutable Login ID.
- Multiple credentials per identity.
- Passwords optional.
- Identity lifecycle state machine.
- Hybrid authorization with RBAC, claims, and policies.
- Global identity with tenant, brand, market, and operator memberships.
- Policy-based sessions.
- Service trust through OAuth2 client credentials with optional mTLS.
- JWT and opaque reference token strategy.
- Full OAuth2/OpenID Connect provider in a future implementation phase.
- Auth is policy authority; services enforce policies locally.

## Domain Model

Phase 23.1 defines the following model contracts:

- `Identity`
- `IdentityType`
- `LoginId`
- `Credential`
- `CredentialType`
- `IdentityLifecycleState`
- `Role`
- `Claim`
- `Policy`
- `Membership`
- `Session`
- `Token`
- `OAuthClient`
- `ServiceAccount`
- `ApiClient`
- `SecurityRelationship`
- `AuditEvent`

## API Skeleton

The service exposes placeholder diagnostics only:

- `GET /health`
- `GET /ready`
- `GET /api/auth-service/status`
- `GET /api/auth-service/identity-model`
- `GET /api/auth-service/oauth-model`
- `GET /api/auth-service/policy-model`

These endpoints do not authenticate users, issue tokens, validate passwords, create sessions, or modify existing platform authentication.

## Boundaries

The Auth Service will not own player balances, settlement results, ledger entries, credit exposure, reservations, game math, draw results, reporting data, or tenant business configuration. It owns identities, credentials, roles, claims, policies, memberships, sessions, tokens, OAuth clients, service accounts, API clients, security relationships, and authentication audit events.

## Deferred Implementation

- Persistent identity store.
- Password hashing and credential verification.
- OAuth2/OpenID Connect runtime.
- Token signing and reference token storage.
- Session issuance and revocation.
- RBAC and policy evaluation runtime.
- Migration from current platform authentication.
- Service-to-service trust enforcement.
- mTLS certificate validation.
- Admin and operator approval workflows for auth changes.

## Exit Criteria

Phase 23.1 is complete when the .NET skeleton builds, domain contracts exist, placeholder APIs return model summaries, tests verify that no production authentication behavior is enabled, and existing platform QA remains unchanged.
