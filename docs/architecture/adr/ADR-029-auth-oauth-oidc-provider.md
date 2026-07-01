# ADR-029 - Auth OAuth/OIDC Provider

## Status

Accepted

## Context

The Auth Service is the platform identity provider and authorization server.

## Decision

Auth Service models OAuth2/OpenID Connect provider behavior, including authorization code, client credentials, refresh token, device code placeholder, token exchange placeholder, redirect URIs, consent grants, JWKS, and OIDC discovery metadata.

Runtime OAuth endpoints are not exposed in Phase 23.4.

## Consequences

- OAuth/OIDC contracts can be tested before production activation.
- Current platform authentication remains unchanged until a migration phase.
