# Phase 23.2 - Auth Persistence Schema & Credential Boundaries

Phase 23.2 defines Authentication Service persistence, repository contracts, credential boundaries, token boundaries, and migration gates. It does not implement production login, password hashing, credential verification, token issuance, OAuth/OIDC runtime behavior, or migration from current platform authentication.

## Persistence Schema

The draft schema is `services/auth-service/database/001_auth_service_schema_draft.sql` and owns the `auth_service` schema.

Tables:

- `auth_service.identities`
- `auth_service.identity_aliases`
- `auth_service.identity_credentials`
- `auth_service.identity_lifecycle_events`
- `auth_service.roles`
- `auth_service.permissions`
- `auth_service.identity_roles`
- `auth_service.identity_claims`
- `auth_service.policies`
- `auth_service.memberships`
- `auth_service.sessions`
- `auth_service.tokens`
- `auth_service.refresh_tokens`
- `auth_service.oauth_clients`
- `auth_service.oauth_client_secrets`
- `auth_service.service_accounts`
- `auth_service.api_clients`
- `auth_service.security_relationships`
- `auth_service.audit_events`
- `auth_service.signing_keys`

The schema separates credentials from identities, OAuth client secrets from client metadata, token metadata from token issuance, and audit/lifecycle evidence from mutable identity state. Login IDs are unique and documented as immutable. Hard deletes are prohibited by policy; trigger enforcement remains deferred for a governed migration phase.

## Credential Boundary

Credential public metadata and secret material are separate. Normal query models expose credential identity, type, public reference, state, and timestamps only. Secret material references are represented by boundary contracts and must not be returned by public model queries.

Credential models:

- `PasswordCredential`
- `TotpCredential`
- `WebAuthnCredential`
- `OAuthFederatedCredential`
- `PamFederatedCredential`
- `ApiKeyCredential`
- `ClientSecretCredential`
- `CertificateCredential`

Passwords remain optional. Multiple credentials per identity are supported. Credentials can be enabled or disabled independently. Verification is intentionally not implemented.

## Token Boundary

The model supports JWT metadata, opaque token references, refresh token rotation, revocation records, introspection records, signing key metadata, and JWKS descriptors.

Token issuance, token introspection, revocation execution, signing, and JWKS serving are not implemented in this phase.

## Repository Contracts

Phase 23.2 adds repository interfaces for identity, aliases, credentials, lifecycle evidence, roles, permissions, claims, policies, memberships, sessions, tokens, refresh tokens, OAuth clients, service accounts, API clients, security relationships, audit events, and signing keys.

Contracts are defined only. Runtime persistence remains unwired.

## Migration Gates

Auth migration readiness is blocked by default.

Default blockers:

- Schema not applied.
- Credential verification not implemented.
- Token issuance not implemented.
- Current platform auth not mapped.
- Session migration not designed.
- OAuth/OIDC not implemented.
- Rollback plan not defined.
- QA migration tests not passed.

## Diagnostics

The Auth Service skeleton exposes diagnostic-only endpoints:

- `GET /api/auth-service/persistence-model`
- `GET /api/auth-service/credential-model`
- `GET /api/auth-service/token-model`
- `GET /api/auth-service/migration-readiness`
- `GET /api/auth-service/schema-status`

No mutation endpoints are added.

## Boundaries

Auth owns identities, credentials, sessions, tokens, OAuth/OIDC clients, service accounts, API clients, security relationships, and auth audit/security events.

Auth does not own player hierarchy, agent hierarchy, financial hierarchy, business account relationships, Settlement, Ledger, or Credit. Business domains reference identities by immutable `IdentityId` or `LoginId`.

## Exit Criteria

Phase 23.2 is complete when schema artifacts, repository contracts, credential/token boundaries, migration gates, diagnostics, tests, package scripts, and QA exist while current platform authentication remains unchanged.
