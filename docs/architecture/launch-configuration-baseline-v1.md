# Mosera Launch Configuration Baseline v1

## Governance

| Field | Value |
| --- | --- |
| Configuration version | `P1-014.5-2026-07-25` |
| Approval status | `APPROVED_BASELINE` |
| Freeze status | `READY_FOR_BACKEND_FREEZE` |
| Environment applicability | Staging and production |
| Owner | Platform Operations |
| Approval date | Controlled deployment approval placeholder |
| Approved by | Controlled deployment approval placeholder |
| Rollback reference | Previous approved image and configuration version |
| Configuration fingerprint | `sha256:ad46a89c0f217a4b9d1c82739d4a5156044b77f1e8d90698947a3912bf83e6da` |

The fingerprint covers the non-secret launch policy in
`src/domains/launch-configuration/launch-configuration.ts`. It does not include
credentials, tokens, connection strings, or signing material.

Any post-freeze change requires a change record, impact assessment, successful
QA rerun, renewed approval, and a new configuration version and fingerprint.

## Approved Operating Model

- Credit-only operation.
- Cashier, cash deposits, cash withdrawals, and payment providers disabled.
- Production UI and self-service onboarding disabled.
- Canonical Platform hierarchy, Ticket path, Outcome publication, and draw
  orchestration only.
- Canonical recovery enabled; legacy Platform, Ticket, and Outcome writers
  disabled.
- Authentication, Credit Wallet, Ledger, and Settlement remain `MONOLITH`.
- Outcome production authority remains disabled pending controlled promotion.
- No silent authority fallback or automatic promotion.
- No development writers outside disposable environments.
- Financial records and authority evidence remain immutable.
- Notifications are limited to durable outbox generation.
- External integrations are disabled.
- Launch products and games are disabled pending explicit business approval.

## Configuration Authority

Environment variables are the runtime input. Production Compose explicitly
passes them to each container. `deploy/production/validate-production-config.sh`
is the fail-closed production and staging admission check. Application and .NET
service loaders validate their owned values at startup. The launch policy module
provides the application readiness checks and non-secret diagnostic fingerprint.

Precedence is: approved release configuration, injected secrets, explicit
environment variables, then service-owned parsing. Staging and production do
not infer local defaults. Secrets are never part of readiness responses or the
configuration fingerprint.

## Environment Separation

| Environment | Policy |
| --- | --- |
| Local | Explicit disposable exceptions are allowed. Local Compose enables the Cashier mutation path for existing QA only. |
| Test | Tests must provide explicit fixtures; missing production values never imply production-safe behavior. |
| Staging | Must satisfy the complete frozen baseline with non-local TLS dependencies and synthetic or staging secrets. |
| Production | Must satisfy the complete frozen baseline with managed dependencies and approved secrets. |

Staging and production reject localhost dependencies, placeholder secrets,
permissive authority modes, local writers, legacy mutation paths, missing
recovery, disabled audit/readiness, and contradictory feature flags.

## Configuration Inventory

| Area | Classification | Frozen requirement |
| --- | --- | --- |
| `DEPLOYMENT_ENVIRONMENT` | Required staging/production | Exact `staging` or `production` |
| Launch version, approval, freeze, fingerprint policy | Required staging/production | Exact governed baseline |
| `DATABASE_URL`, `MIGRATIONS_DATABASE_URL` | Required production; migration URL migration-only | Non-local PostgreSQL with TLS |
| `REDIS_URL` | Required staging/production | Non-local authenticated TLS endpoint |
| `RABBITMQ_URL` | Required staging/production | Non-local CloudAMQP-compatible TLS endpoint |
| RabbitMQ management URL/token | Optional production operations | Secret token; not required for runtime |
| Supabase URL and keys | Required production transitional dependency | HTTPS, non-placeholder; no local bootstrap assumptions |
| `AUTH_PROVIDER`, `AUTH_AUTHORITY` | Required staging/production | `auth-service`, `MONOLITH` |
| Auth URL, issuer, audience, signing/session keys | Required staging/production | Explicit non-local URLs and approved secret material |
| Session duration, refresh duration, cookie policy | Required staging/production | Service-owned validated values; secure cookies at edge |
| MFA and break-glass policy | Required production security policy | Existing Auth Authority policy; no debug authentication |
| `CREDIT_AUTHORITY` | Required staging/production | `MONOLITH` |
| `LEDGER_AUTHORITY` | Required staging/production | `MONOLITH` |
| `SETTLEMENT_AUTHORITY` | Required staging/production | `MONOLITH` |
| Outcome pipeline, legacy, recovery | Required staging/production | `false`, `false`, `true` respectively |
| Canonical draw orchestration | Required staging/production | Enabled |
| Legacy Platform/Ticket mutation flags | Required staging/production | Disabled |
| Credit-only and Cashier/payment flags | Required staging/production | Credit-only true; all cash/payment paths false |
| Product/game launch state | Required staging/production | Disabled pending business approval |
| Worker enablement | Required staging/production | All required workers explicitly present |
| OTEL endpoint, headers, service/resource attributes | Required production | Managed Grafana Cloud export, no placeholder values |
| Caddy domain/origin TLS settings | Required production | Explicit domain, HTTPS-ready trusted proxy posture |
| CORS/public origins | Required production | Explicit HTTPS origins; no wildcard |
| Migration approval/evidence flags | Migration-only | Governed runner only; never inferred |
| Local database/broker/cache credentials | Local development only | Disposable Compose only |
| QA seeds, fixture credentials, approval flags | Test only | Disposable CI/local QA only |
| Local Cashier mutation enablement | Local development only | Explicitly true only in disposable local Compose |
| Production service image tags | Required production | Immutable SHA-based references |

Deprecated Supabase-era mutation APIs are not configuration authorities. The
remaining Supabase connection is a declared managed data dependency until its
separate retirement package. Unreferenced or deprecated keys must not be added
to a release environment merely to satisfy old fixtures.

## Authority Baseline

| Authority | Production default | Fallback | Promotion prerequisite | Rollback |
| --- | --- | --- | --- | --- |
| Authentication | `MONOLITH` routing with Auth Service provider | None | Separate controlled promotion evidence | Restore approved `MONOLITH` release |
| Credit Wallet | `MONOLITH` | None | Service guardrails and promotion approval | Restore `MONOLITH` |
| Ledger | `MONOLITH` | None | Service guardrails and promotion approval | Restore `MONOLITH` |
| Settlement | `MONOLITH` | None | Promotion-ready evidence plus explicit promotion | Restore `MONOLITH` |
| Outcome/Game Engine | Production generation disabled | None | All activation guardrails and controlled promotion | Keep generation disabled |
| Ticket | Canonical path | None | Already frozen; no legacy writer | Roll back release, never enable legacy |
| Platform Management | Canonical hierarchy | None | Already frozen; no legacy writer | Roll back release, never enable legacy |

Readiness reports the selected non-secret mode. Contradictory or `SERVICE`
authority settings fail configuration admission.

## Ticket Permissions

| Role | `tickets.read` | `tickets.create` | `tickets.cancel` |
| --- | --- | --- | --- |
| Super Admin | Yes | Yes | Yes |
| Operations Admin | Yes | Yes | Yes |
| Read-only Auditor | Yes | No | No |

Permission seeds are idempotent and use the existing Auth Service RBAC role
metadata. Resource scope and hierarchy checks remain mandatory. Agent/player
access is denied unless an existing authenticated scope and permission grants
it. Cancellation remains subject to canonical Ticket lifecycle and durable
Wallet correlation rules.

## Product And Credit Status

No game family, product, manifest, paytable, wager definition, draw schedule,
sales cutoff, optional wager, or external result source is silently approved by
this package. Production product availability is explicitly disabled pending a
business-approved immutable product package. Currency, language, timezone,
payout constraints, and market availability are bound through that package.

Credit reservation, release, settlement, cancellation release, exposure, and
hierarchy controls remain the approved credit-only financial model. Cash
funding, deposits, withdrawals, Cashier completion, and payment providers are
blocked by configuration and application mutation guards.

## Runtime Dependencies

PostgreSQL, RabbitMQ, Redis, migrations, the application, Auth Service, Credit
Wallet Service, Ledger Service, Settlement Service, and Game Engine are required.
Integrity-critical dependency failure is fail-closed and removes readiness.
Retries must remain bounded and idempotent; degraded financial or Outcome writes
are not allowed. Managed infrastructure commissioning is a deployment activity,
not part of this freeze package.

Required launch workers are:

- outbox dispatcher
- critical financial
- ticket lifecycle
- settlement
- accounting
- commission
- reconciliation
- operational access
- reporting

Canonical Outcome recovery and draw orchestration run in Game Engine under their
explicit flags. Notification generation is outbox-only. Duplicate delivery is
handled through durable idempotency; duplicate worker authority is not assumed
safe unless its existing lease/claim contract permits it.

## Security And Observability

Production requires explicit secure origins, trusted proxy posture, secret and
token validation, secure session behavior, fail-closed Auth Service readiness,
audit recording, logging redaction, and disabled debug/seed routes. Existing MFA,
break-glass, emergency account, password, lockout, refresh replay, and audit
policies remain authoritative and are not redesigned here.

Required diagnostic evidence includes structured logs, correlation and causation
IDs, immutable audit records, migration state, outbox and worker status,
authority modes, dependency health, and the non-secret configuration fingerprint.
Advanced dashboards and alerting remain deferred.

## Freeze Readiness

| Domain | Assessment |
| --- | --- |
| Authentication and RBAC | READY FOR FREEZE |
| Platform, Accounts, Players, Agents | READY FOR FREEZE |
| Credit Wallet, Ledger, Ticket | READY FOR FREEZE |
| Draw, Outcome, Settlement, Game Engine | READY WITH DOCUMENTED DEFERRED PROMOTION |
| Game catalog and availability | READY WITH PRODUCTS EXPLICITLY DISABLED |
| Reporting and notifications | READY WITH DOCUMENTED DEFERRED WORK |
| Audit, workers, messaging, persistence | READY FOR FREEZE |
| Configuration, health, readiness | READY FOR FREEZE |
| Legacy-path isolation | READY FOR FREEZE |
| Production UI, Cashier, payment providers | NOT IN LAUNCH SCOPE |

There is no backend-freeze blocker while products remain disabled. Deployment
approval still requires real secrets, managed dependencies, approved product
configuration, migration evidence, and the normal release gates.

## Freeze Rules

After freeze, only defect, security, acceptance-criteria, production-readiness,
pre-promotion migration corrections, and approved configuration changes are
allowed. New features, authorities, lifecycle states, product families, APIs,
speculative schema, architectural redesign, and backlog implementation are not.

## Innovation Backlog

- Centralized configuration and dynamic feature-management services.
- Automated secrets rotation and environment promotion.
- Expanded policy as code.
- Advanced observability, alerting, and operational dashboards.
- Configuration UI and tenant self-service.
- Automated rollback orchestration.
- Multi-region runtime configuration.
