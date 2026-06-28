# Phase 22.1 - Targeted Security Remediation

## Purpose

Phase 22.1 remediates the Phase 22.0 medium security findings that can be
addressed without changing authentication architecture, OAuth semantics, API
contracts, financial behavior, authority routing, or deployment architecture.

## Findings Remediated

| ID | Result | Notes |
| --- | --- | --- |
| SEC-AUTH-RATE-LIMIT-001 | Implemented | Sensitive auth endpoints now use process-local IP and identifier limits. |
| SEC-INFRA-RABBITMQ-001 | Implemented | Security posture detects default RabbitMQ credentials and escalates when production secret enforcement is enabled. |
| SEC-DEPENDENCY-AUDIT-001 | Implemented | `security:audit` and `ops:dependency-audit` provide a configurable npm audit release gate. |
| SEC-CSP-STRICTNESS-001 | Implemented where safe | CSP now adds frame, media, manifest, and worker restrictions while retaining Next-compatible script/style allowances. |

## Auth Rate Limiting

The auth rate limiter is intentionally narrow and local to sensitive endpoints:

- `/api/auth/login`
- `/api/auth/password-reset/request`
- `/api/auth/password-reset/confirm`
- `/api/auth/mfa/challenge/verify`
- `/api/auth/mfa/totp/verify`
- `/api/oauth/token`
- `/api/oauth/introspect-self`

Limits are enforced by IP when available and by identifier when the request body
contains a username, email, token, challenge token, code, or client id. Responses
remain generic and avoid account-existence disclosure.

The implementation is in-memory. It is safe for this local and QA baseline, but
it is not distributed across multiple Node.js processes. Production horizontal
scaling should replace or back it with shared storage.

## RabbitMQ Secret Policy

Local development may continue using the Compose defaults. Production
deployments must provide non-default RabbitMQ credentials through environment
configuration and set:

```text
SECURITY_ENFORCE_PRODUCTION_SECRETS=true
```

When production secret enforcement is enabled and a known development RabbitMQ
credential is detected, security status reports `ACTION_REQUIRED`. Secrets are
not printed in logs or reports.

## Dependency Audit Policy

Phase 22.1 adds:

- `security:audit`
- `ops:dependency-audit`

Both run `npm audit` with `SECURITY_AUDIT_LEVEL`. The local/QA default is
`critical` so existing high/moderate advisories remain visible without blocking
every development run. CI can set the threshold to `high` or `moderate` as the
release policy matures.

No dependencies were upgraded automatically in this phase.

## CSP Changes

The CSP was tightened by adding:

- `frame-src 'none'`
- `media-src 'self'`
- `manifest-src 'self'`
- `worker-src 'self' blob:`

The policy still allows inline styles and inline/eval scripts for compatibility
with the current Next.js runtime and local QA stack. A nonce/hash-based CSP
remains deferred for architecture review.

## Deferred Items

- Distributed auth rate limiting for horizontally scaled production.
- Nonce/hash-based CSP.
- CI threshold decision for high/moderate dependency advisories.
- Production secret manager integration.

## Recommendation for Phase 22.5

Proceed to security architecture review and deployment policy hardening:
distributed rate limiting, release-gate severity thresholds, production secret
enforcement, RabbitMQ/Redis network exposure policy, and strict CSP design.
