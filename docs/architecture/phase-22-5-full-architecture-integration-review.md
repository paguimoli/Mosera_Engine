# Phase 22.5 - Full Architecture, Integration & Product Direction Review

## Executive Summary

The platform is ready to move from extraction/hardening into deployment
engineering. Settlement, Ledger, and Credit Wallet have been promoted,
certified, monitored, tested for post-promotion activity, validated under
performance and resilience baselines, and covered by the initial security
hardening pass.

The correct next step is not another service extraction. The next step is
production deployment readiness: staging/VPS deployment, CI/CD, production
secret policy, backup/restore validation, monitoring/alerting, native database
telemetry, and release operations.

No promoted financial service requires redesign before deployment. Comparison
mode and rollback should remain enabled through staging and the first production
launch window.

## Current Platform Baseline

- Settlement: SERVICE / CERTIFIED
- Ledger: SERVICE / CERTIFIED
- Credit Wallet: SERVICE / CERTIFIED
- Comparison: ENABLED
- Rollback: READY
- Performance Engineering: COMPLETE
- Resilience Engineering: COMPLETE
- Security Baseline and Targeted Remediation: COMPLETE
- `qa:all`: PASS

## 1. Migrated Services Review

### Settlement Service

Assessment: production-candidate, certified.

The Settlement Service has completed authority promotion, post-promotion
monitoring, rollback drill simulation, stabilization activity, and operator
certification. No redesign is required before deployment.

Recommendation: keep authoritative in SERVICE mode. Keep comparison enabled
until staging burn-in and the first production launch window are complete.

### Ledger Service

Assessment: production-candidate, certified with auditability follow-up.

Ledger is authoritative and certified. Evidence hardening identified advisory
warnings around database-level immutability proof and direct reference coverage.
Those warnings do not invalidate the service promotion, but they should remain
tracked as production-readiness items.

Recommendation: keep authoritative in SERVICE mode. Keep comparison enabled.
Complete database-level immutability proof and ledger reference remediation
policy before launch, not necessarily before first deployment to staging.

### Credit Wallet Service

Assessment: production-candidate, certified.

Credit Wallet is authoritative and certified after post-promotion activity.
Because it touches balances, reservations, exposure, settlement application, and
accounting views, rollback must remain ready through launch.

Recommendation: keep authoritative in SERVICE mode. Keep comparison enabled and
rollback ready through launch and early production monitoring.

### Authority Routing

Assessment: healthy.

The authority lifecycle is consistent across Settlement, Ledger, and Credit:
approval capture, controlled promotion, post-promotion monitoring,
stabilization, certification, rollback readiness, and audit events are present.

Recommendation: no authority routing change before deployment.

### Comparison Mode

Assessment: should remain enabled.

Comparison mode provides post-extraction safety evidence and should not be
disabled before staging. It may remain enabled after launch until production
confidence is established and operating cost is understood.

Recommendation: keep enabled through staging, launch, and initial production
monitoring.

### Rollback Readiness

Assessment: ready and should remain ready.

Rollback drills are simulated and rollback readiness is part of baseline,
resilience, and security QA.

Recommendation: do not disable rollback until after production burn-in and a
formal rollback decommission decision.

## 2. Future Service Extraction Candidates

| Domain | Recommendation | Rationale |
| --- | --- | --- |
| Authentication | Needs further design | Security-sensitive and cross-cutting. Keep in monolith until OAuth/provider mode, distributed rate limiting, session policy, and audit boundaries are designed. |
| Cashier | Extract after deployment | Payment gateway coupling and reconciliation make it a strong future candidate, but extraction before deployment would add risk before gateway selection. |
| Notifications | Extract after deployment | Natural async boundary. Can wait until channels, templates, and delivery providers are selected. |
| Reporting | Extract after deployment | Read-heavy and operationally separable, but not launch-blocking. |
| Draw Engine | Needs further design | RNG/draw authority strategy is not mature enough. Requires dedicated design before production launch. |
| Game Engine | Needs further design | Multi-game availability, rules, markets, and provider strategy need product decisions before extraction. |
| Worker Orchestration | Keep in monolith for deployment | Workers are activated and observable. Extract only if scaling or operational isolation demands it. |
| Admin Operations | Keep in monolith | Admin operations are tightly coupled to authority controls, audit, and runbooks. Extraction would add complexity without launch benefit. |

No additional service should be extracted before the first staging deployment.

## 3. Deferred Production Register

| Item | Category | Reason Deferred | Risk If Forgotten | Latest Safe Phase | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Distributed rate limiting | Security | In-memory limiter is sufficient for local/QA, not horizontal production. | Brute-force protection fragments across replicas. | Before production launch | Implement shared Redis or gateway-backed limiter. |
| Strict nonce/hash CSP | Security | Requires framework/runtime asset validation. | XSS blast-radius reduction remains incomplete. | Before public launch | Design CSP with nonce/hash support after staging asset review. |
| Production secret management | Security/Deployment | Needs deployment environment decision. | Default or unmanaged secrets leak privileged access. | Before staging | Use VPS/staging secret injection and fail-safe checks. |
| Dependency audit policy | Security/Supply chain | Threshold decision belongs in release policy. | Known vulnerable packages may ship unnoticed. | Before CI release gate | Set CI threshold and remediation workflow. |
| Native DB telemetry / EXPLAIN | Operations/DB | Supabase REST limits direct native visibility. | Slow queries and locks may be harder to diagnose. | Before launch | Add native telemetry path for staging/prod. |
| Database-level ledger immutability proof | Financial audit | Evidence currently distinguishes app-enforced from DB-enforced. | Audit confidence is weaker for ledger append-only guarantees. | Before launch | Add formal DB proof or documented Supabase constraint evidence. |
| Ledger reference remediation policy | Financial audit | Remediation is operator-reviewed and evidence-only. | Missing references may remain unresolved. | Before launch | Approve policy for remediation, backfill, or accepted exceptions. |
| Production RabbitMQ credentials | Security/Infra | Local defaults preserved for QA. | Message bus compromise. | Before staging | Inject non-default credentials and restrict management UI exposure. |
| Staging/VPS deployment | Deployment | Not yet executed in repo lifecycle. | Production issues discovered too late. | Next phase | Build repeatable staging deployment. |
| Backup/restore validation | Resilience | Requires staging/prod-like data and storage. | Recovery assumptions unproven. | Before launch | Run restore drills and document RPO/RTO. |
| CI/CD | Delivery | Local validation exists; automated gate not formalized. | Manual release drift and missed gates. | Before launch | Add lint/build/QA/security audit pipeline. |
| Monitoring/alerting | Operations | Evidence APIs exist; alerting not wired. | Failures depend on manual discovery. | Before launch | Add alert policy for authority, outbox, queues, health, and financial mismatches. |
| Multi-brand frontend | Product/UI | Backend has brand primitives, but full product routing needs design. | Rework if UI assumes single brand. | Before public UI launch | Design brand/domain resolution foundation. |
| Multilingual support | Product/UI | Copy management not yet defined. | Hard-coded UI copy blocks target markets. | Before public UI launch | Design translation model and fallback policy. |
| Agent website access rules | Product/Auth | Needs product rules and security review. | Agents may see or expose incorrect branded sites. | Before public UI launch | Model agent-site permissions. |
| Per-agent game availability | Product/Game | Requires game/market policy decisions. | Incorrect game access by agent or market. | Before game launch | Implement rule model before broad game rollout. |

## 4. Third-Party Integration Review

| Integration | Classification | Recommendation |
| --- | --- | --- |
| OAuth provider mode | Required before launch | Keep current client credentials support, but design external provider mode, token validation, scopes, and session mapping before public launch. |
| PAM integrations | Depends on partner selection | Do not build until provider, jurisdiction, and compliance requirements are selected. |
| Payment gateways | Required before launch | Cashier can remain monolith, but gateway abstraction, reconciliation, idempotency, and webhook security must be designed before money movement launch. |
| Lottery authority feeds | Depends on jurisdiction/partner | Required if the launch market depends on official draw feeds. |
| External RNG/draw providers | Depends on game model | Required for certified RNG games if internal draw authority is not sufficient. |
| External game suppliers | Depends on product strategy | Can wait unless launch requires supplier games. |
| Webhooks | Required before launch for payments/partners | Add signature verification, replay protection, idempotency, and versioning before receiving external events. |
| Partner APIs | Depends on partner selection | Build only after partner requirements are known. |
| OpenAPI / API versioning | Required before launch | Needed for partner integrations, operational handoff, and stable external contracts. |

## 5. Draw Engine / RNG Strategy

Draw/RNG readiness is the weakest launch domain because it has not gone through
the same authority lifecycle as Settlement, Ledger, and Credit.

Review conclusions:

- Internal PRNG/CSPRNG provider: feasible for internal simulation, but not
  sufficient as a production strategy without certification and audit controls.
- External certified RNG provider: likely required for regulated RNG products.
- Lottery authority draw import: required for official lottery products that
  mirror external draws.
- Draw provider abstraction: required before supporting multiple draw sources.
- Draw authority lifecycle: should mirror Settlement/Ledger/Credit authority
  patterns.
- Draw certification: required before launch of draw-dependent products.
- Immutable draw records: required for audit and dispute resolution.
- Statistical validation: required for internal RNG products.
- Algorithm versioning: required for RNG auditability and reproducibility.
- Multi-game support: needs product rules, market availability, and per-agent
  controls.

Recommendation: create a dedicated Phase 22.6 for Draw Engine / RNG Authority
Strategy before public launch. This does not need to block staging deployment of
the current backend, but it should block launch of draw/RNG-dependent products.

## 6. Product / UI / UX Architecture

The backend has a strong operational and financial foundation, but public UI
architecture needs foundation work before serious UI implementation.

Required product architecture decisions:

- Multiple URLs and brands using the same backend.
- Domain-based brand resolution.
- Agent-specific website access.
- Multilingual copy and fallback behavior.
- Admin-managed translated copy.
- Per-agent game enablement.
- Per-market game enablement.
- Theming boundaries.
- Player UI separation from admin UI.
- Admin UI operations model for brands, games, agents, markets, and content.

Assessment: the backend can support this direction, but the product-facing
foundation is not complete enough for a final UI build.

Recommendation: do product foundation after deployment readiness and before
public launch UI. Do not block staging deployment.

## 7. Architecture Health Score

| Area | Score | Notes |
| --- | ---: | --- |
| Financial engine | 9 | Core financial authorities are promoted, certified, and QA-covered. |
| Event architecture | 8 | Outbox and workers are active; alerting and production lag policy remain. |
| Settlement | 9 | Certified and stable. |
| Ledger | 8 | Certified; immutability/reference evidence needs production closure. |
| Credit | 9 | Certified and stable; rollback should remain enabled. |
| Auth/RBAC | 8 | Strong RBAC/session baseline; distributed limiter and OAuth provider mode remain. |
| Security | 7 | Medium findings remediated; production secret/CSP/release gate policy remain. |
| Performance | 8 | Baseline complete with no critical repeated bottleneck. |
| Resilience | 8 | Recovery/idempotency/fault injection validated; backup/restore remains. |
| Deployment readiness | 5 | Staging/VPS, CI/CD, secrets, monitoring, backups still pending. |
| Integration readiness | 5 | External provider strategy not selected. |
| Draw/RNG readiness | 4 | Needs dedicated authority/design phase. |
| Product/UI readiness | 5 | Product rules and multi-brand/multilingual foundation pending. |
| Documentation | 8 | Extensive phase docs/runbooks exist; deployment docs are next. |
| Operational readiness | 7 | Strong ops scripts/evidence APIs; alerting and deployment operations pending. |

Overall score: 7.2 / 10.

## 8. Launch Blockers

### Must Fix Before Deployment

- Staging/VPS deployment plan and environment configuration.
- Production secret injection and RabbitMQ non-default credentials.
- CI/CD baseline for lint, build, QA, dependency audit, and deployment.
- Backup/restore validation plan for Supabase and operational data.

### Must Fix Before Launch

- Monitoring and alerting.
- Strict production release policy for dependency audit threshold.
- Ledger immutability proof and reference remediation policy.
- Draw/RNG authority strategy if launching draw/RNG-dependent games.
- Payment gateway/webhook security if launching money movement.
- OpenAPI/API versioning for partners or external consumers.
- Product foundation for brands, languages, agent access, and game availability.

### Can Wait Until Post-Launch

- Reporting service extraction.
- Notifications service extraction.
- Worker orchestration extraction.
- Cashier extraction, if initial payment integration remains low-volume and
  well-contained.
- External game suppliers, if not part of launch product.

### Should Be Discarded For Now

- Additional financial service extractions before staging.
- Disabling comparison mode before launch.
- Disabling rollback before launch.
- Broad authentication redesign before provider requirements are selected.

## Recommended Next Phase

Phase 23.0 should be Deployment Readiness & Staging/VPS Baseline.

The goal should be to deploy the current certified architecture into a
production-like environment without changing financial behavior:

- environment and secret management
- staging domain and TLS
- CI/CD
- database backup/restore drill
- production RabbitMQ/Redis posture
- monitoring and alerting
- deployment runbook
- smoke and `qa:all` validation against staging

Phase 22.6 should be scheduled in parallel or immediately after deployment
baseline if launch depends on draw/RNG products.
