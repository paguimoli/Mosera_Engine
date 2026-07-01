# ADR-022 - Auth Credentials Separated From Identities

## Status

Accepted

## Context

The platform must support passwordless users, multiple credentials per identity, OAuth/PAM federation, API keys, client secrets, and client certificates. Identity records must remain stable while credentials rotate, expire, or are disabled.

## Decision

Credentials are stored separately from identities. Credential metadata and secret material are separated further. Normal query models expose only public credential metadata. Secret material references are handled through restricted repository boundaries.

## Consequences

- Passwords are optional.
- Multiple credentials can be attached to one identity.
- Credentials can be individually enabled, disabled, rotated, or expired.
- Credential verification is deferred to a later phase.
- Secret fields must not be returned through public diagnostic or identity query models.
