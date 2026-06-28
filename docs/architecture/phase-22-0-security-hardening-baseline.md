# Phase 22.0 - Security Hardening Baseline

## Purpose

Phase 22.0 establishes the first production security baseline after settlement,
ledger, and credit authority extraction. The phase is assessment-first: security
changes are limited to issues that reduce a verified production risk without
changing authority, routing, financial calculations, or API contracts.

## Security Posture

The current platform keeps the three financial authorities in the expected
state:

- Settlement: SERVICE / CERTIFIED
- Ledger: SERVICE / CERTIFIED
- Credit: SERVICE / CERTIFIED
- Comparison: ENABLED
- Rollback: READY

Administrative and operational APIs are protected by the existing bearer-session
authentication and RBAC middleware. Session tokens are stored server-side as
hashes, password hashes use Argon2id, and financial authority APIs require
administrative permission checks.

## Implemented Improvement

The assessment found that the application did not define a global browser
security header policy. Phase 22.0 adds a compatibility-safe baseline in
`next.config.ts`:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- `Permissions-Policy` denying high-risk browser features
- `Cross-Origin-Opener-Policy: same-origin`
- `Content-Security-Policy` with frame/object restrictions and Next-compatible
  script/style allowances

The CSP is intentionally compatibility-first. A stricter nonce/hash-based CSP is
deferred until production asset and script requirements are finalized.

## Findings

| ID | Severity | Status | Area | Finding |
| --- | --- | --- | --- | --- |
| SEC-HTTP-HEADERS-001 | MEDIUM | IMPLEMENTED | HTTP security | Global HTTP security headers were missing. |
| SEC-AUTH-RATE-LIMIT-001 | MEDIUM | DEFERRED | Authentication | Auth endpoints rely on account lockout but do not expose a dedicated request rate limiter. |
| SEC-CSP-STRICTNESS-001 | LOW | DEFERRED | HTTP security | CSP is compatibility-first rather than nonce/hash based. |
| SEC-INFRA-RABBITMQ-001 | MEDIUM/INFO | DEFERRED/ACCEPTED | Infrastructure | RabbitMQ credentials must be production-managed secrets. |
| SEC-SECRETS-SUPABASE-001 | HIGH/INFO | DEFERRED/ACCEPTED | Secrets | Supabase service role secrets must be externally managed. |
| SEC-CONTAINER-USER-001 | INFORMATIONAL | ACCEPTED | Container | Runtime container runs as the node user. |
| SEC-PASSWORD-HASHING-001 | INFORMATIONAL | ACCEPTED | Authentication | Password storage uses Argon2id. |
| SEC-SESSION-TOKEN-001 | INFORMATIONAL | ACCEPTED | Session management | Session tokens are server-side hashed bearer tokens. |
| SEC-RBAC-ADMIN-001 | INFORMATIONAL | ACCEPTED | Authorization | Operations APIs use permission-gated access. |
| SEC-DEPENDENCY-AUDIT-001 | MEDIUM | DEFERRED | Supply chain | Dependency vulnerability posture needs CI release-gate audit review. |

Runtime-dependent findings may shift between MEDIUM/HIGH and INFORMATIONAL
depending on injected production secrets.

## Deferred Improvements

- Add deployment-aware auth rate limiting for login and password reset flows.
- Replace the compatibility CSP with nonce/hash-based CSP after production
  runtime validation.
- Enforce production secret validation for RabbitMQ, Redis, and Supabase before
  deployment start.
- Add dependency vulnerability scanning and reviewed remediation to CI release
  gates.
- Review RabbitMQ and Redis network exposure assumptions in production
  infrastructure.

## Risk Register

No critical finding was identified in this baseline. Deferred high and medium
items are operational hardening tasks that require deployment assumptions,
credential policy, or CI release-gate decisions. They are documented and exposed
through the security operations APIs.

## Operations APIs

- `GET /api/operations/security-status`
- `GET /api/operations/security-findings`
- `GET /api/operations/security-summary`

All three endpoints are protected, read-only, and do not mutate financial or
authority state.

## Phase 22.1 Update

Phase 22.1 remediated the medium findings that were safe to address before
architecture review:

- Auth endpoint rate limiting was added for login, password reset, MFA, and
  OAuth-sensitive paths.
- RabbitMQ default credential detection now escalates when production secret
  enforcement is enabled.
- Dependency audit release-gate tooling was added.
- CSP was tightened where safe while retaining runtime-compatible script/style
  allowances.

Remaining items are intentionally deferred to security architecture review:
distributed rate limiting, strict nonce/hash CSP, CI audit threshold policy, and
production secret manager integration.

## Recommendation for Phase 22.1

Proceed to targeted security remediation: production secret enforcement,
authentication rate limiting, dependency audit release gates, and CSP tightening.
Keep each change independently validated against the authority and financial QA
suite.
