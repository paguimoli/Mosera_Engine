# ADR-025 - Auth Passwords Optional

## Status

Accepted

## Context

The platform must support identities authenticated by passwords, passkeys, federation, service credentials, certificates, or PAM relationships.

## Decision

Passwords are optional. An identity may have zero password credentials and one or more alternative credentials.

Password policy is still modeled for identities that use passwords. Plaintext password storage is prohibited, and the final password hashing implementation is deferred.

## Consequences

- Passwordless identities are first-class.
- Credential policy can evolve without requiring every identity to own a password.
- Password reset and hashing implementation remain explicit future work.
