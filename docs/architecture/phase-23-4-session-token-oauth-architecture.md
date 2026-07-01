# Phase 23.4 - Session Creation, Token Issuance & OAuth/OIDC Architecture

## Scope

Phase 23.4 defines Auth Service session, token, OAuth/OIDC, JWKS, and service-to-service trust architecture. It does not enable production login, token issuance, OAuth runtime endpoints, or current platform auth migration.

## Session Architecture

Sessions are policy-based. The model supports interactive, API client, service account, machine-to-machine, federated, impersonation, and break-glass session types.

Session policy includes max concurrent sessions, idle timeout, absolute lifetime, MFA requirement, device trust placeholder, IP/geography placeholder, forced logout, revocation, and identity lifecycle validation.

Session creation remains diagnostic only.

## Token Architecture

The Auth Service token strategy is hybrid:

- JWT access tokens for locally verifiable claims.
- Opaque reference tokens for introspection-controlled scenarios.

Access tokens are short-lived. Refresh tokens are optional, policy-controlled, and rotation-aware. Token revocation, introspection, and token exchange are modeled, but runtime issuance is disabled.

## OAuth/OIDC Architecture

The Auth Service is modeled as an OAuth2/OpenID Connect authorization server. Authorization code, client credentials, refresh token, device code placeholder, and token exchange placeholder grant types are represented.

Client types include confidential, public, first-party, third-party, and service clients. Redirect URIs, consent grants, client secret rotation, JWKS, and OIDC discovery metadata are modeled.

OAuth runtime endpoints remain deferred.

## Claims Model

Standard claims include identity ID, Login ID, identity type, lifecycle state, session ID, roles, permissions, memberships, brand IDs, market IDs, operator IDs, jurisdiction IDs, MFA level, authentication method, token type, and scopes.

Business hierarchy is not owned by Auth beyond membership scope claims.

## Service-to-Service Trust

Service trust uses OAuth2 client credentials with optional future mTLS binding. Service tokens are short-lived, require scopes, and require audit evidence.

Client secrets and certificates are metadata references only.

## Activation Gates

Session runtime, token issuance, and OAuth runtime gates are disabled by default. Blockers include inactive signing keys, inactive credential verification, inactive persistence, inactive refresh token storage, inactive token revocation, unapproved OAuth endpoints, unapproved platform migration, and missing runtime QA.

## Diagnostics

Architecture-only diagnostics:

- `GET /api/auth-service/session-model`
- `GET /api/auth-service/token-issuance-model`
- `GET /api/auth-service/oauth-model/runtime`
- `GET /api/auth-service/jwks-model`
- `GET /api/auth-service/service-auth-model`
- `GET /api/auth-service/session-readiness`
- `GET /api/auth-service/token-readiness`
- `GET /api/auth-service/oauth-readiness`

No production login or token endpoint is added.

## Exit Criteria

Phase 23.4 exits when session, token, OAuth/OIDC, JWKS, service auth models, activation gates, tests, QA, and documentation exist while runtime auth remains disabled.
