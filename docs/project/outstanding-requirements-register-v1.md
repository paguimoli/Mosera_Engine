# Outstanding Requirements Register v1

## 1. Purpose

This register is the standing project governance record for remaining work,
deferred decisions, and parked ideas after the P0-001 through P0-005 milestone
sequence.

It is not an implementation plan for a single sprint. It is the source of truth
for what remains before the platform can move from architecture and local
runtime readiness into controlled launch preparation.

## 2. Current Milestone Progress

| Milestone | Area | Current Progress | Remaining Governance Note |
| --- | --- | --- | --- |
| P0-001 | Production Authentication | Auth Service durable persistence, login/logout/session validation, `/me`, Next.js feature-flag cutover, permission mapping, seeded local QA, JWT/JWKS, refresh rotation, and service tokens have been implemented and verified through local runtime QA. | OAuth/OIDC production activation, secret custody, production key rotation, and legacy-auth retirement remain launch governance items. |
| P0-002 | Financial Authority | Financial guardrails, durable settlement persistence, settlement ledger effects, cashier atomic completion, and real financial worker handling have been implemented with QA coverage. | SERVICE authority must remain guarded; production reconciliation, incident runbooks, and launch-mode financial operating procedures still need final approval. |
| P0-003 | Service Authority Promotion | Ledger, Credit Wallet, and Settlement Service capability baselines, dry runs, controlled authority switches, and guardrail evidence have been built without changing production defaults. | Authority defaults must remain conservative until launch readiness evidence and operator approvals are complete. |
| P0-004 | Production Infrastructure | Production compose split, Caddy reverse proxy, config enforcement, managed service wiring, CI/CD/GHCR pipeline, migration governance, observability baseline, production runtime QA, queue/DLQ operations, and container/network hardening have been implemented. | No production deployment is enabled. Real managed credentials, secret manager integration, staging rehearsal, and deployment evidence remain required. |
| P0-005 | Outcome, RNG, Math, and Certification Governance | Outcome Authority ADRs, immutable manifest/certificate schemas, Outcome DSL, Math/RTP governance, RNG provider evidence, dry-run Outcome pipeline, dry-run Math Evaluation certificates, and Certification Pack v1 export storage have been implemented. | Production signing, production RNG authority activation, lab certification workflow, and UI/API export surfaces remain future work. |

## 3. Current Core Services

| Service | Current Role | Authority Posture |
| --- | --- | --- |
| Next.js app | Current application shell, operator/admin APIs, feature-flagged Auth Service client, authority routing layer, QA and operations endpoints. | Still the primary orchestration surface for many platform workflows. |
| Auth Service | Durable identity/session/token service with login runtime and service-token foundation. | Candidate identity provider; production cutover remains guarded. |
| Game Engine | Durable game engine persistence, registry/catalog, draw authorities, schedules/lifecycle, Outcome/Math/Certification governance contracts. | Dry-run authority only for P0-005 outcome/math/certification work. |
| Ledger Service | Durable immutable posting, reversal, account query, and controlled authority switch support. | SERVICE-capable behind guardrails; defaults remain conservative unless explicitly promoted. |
| Credit Wallet Service | Durable read, reserve/release, settlement apply, reconciliation, and controlled authority switch support. | SERVICE-capable for covered operations behind guardrails. |
| Settlement Service | Durable persistence, execution dry run, Ledger/Credit integration dry run, recovery/resume, resettlement/reversal dry run, and controlled authority switch support. | SERVICE-capable behind guardrails; production settlement authority still requires launch approval. |
| Workers | Financial worker handling, outbox/event processing, queue/DLQ operation support. | Must remain idempotent and replay-safe. |
| RabbitMQ / CloudAMQP target | Local RabbitMQ for development; CloudAMQP intended for production. | Production topology and DLQ controls documented, not deployed. |
| Redis / Managed Redis target | Local Redis for development; managed Redis intended for production. | Production connection and readiness expectations exist. |
| PostgreSQL / Managed PostgreSQL target | Local Postgres for development/runtime QA; managed PostgreSQL intended for production. | Production migrations require governance approval and evidence. |

## 4. Remaining P0 Work

The following P0 areas remain open after P0-005:

| P0 Item | Name | Objective | Exit Criteria |
| --- | --- | --- | --- |
| P0-006 | Platform Management Foundation | Build the operator-facing foundation needed to manage the platform safely before any broader launch. | Admin workflows, configuration governance, launch-mode controls, evidence views, and operational approval paths are available and QA-backed. |
| P0-007 | Launch Product Configuration | Freeze the first launch product set, markets, rules, limits, risk posture, and operational defaults. | Launch configuration can be exported, reviewed, approved, and reproduced. |
| P0-008 | Staging Rehearsal | Run the production-like topology against staging credentials and staging managed services. | Migration, startup, rollback, observability, queue, and runtime QA evidence is captured. |
| P0-009 | Production Deployment Readiness | Prepare the first production deployment without enabling public launch. | Images, secrets, DNS, TLS, migrations, runbooks, backup/PITR, and incident procedures are approved. |
| P0-010 | Controlled Beta / Launch Gate | Execute the approved launch mode. | Launch checklist is signed off, rollback path is verified, and monitoring is live. |

## 5. P0-006 Platform Management Foundation

P0-006 should focus on management capabilities rather than new product behavior.

Required foundations:

- platform status dashboard for service health, readiness, authority posture, and production blockers
- launch configuration register for markets, games, limits, payment posture, and operational mode
- approval workflow for authority promotion, production migration, certification pack acceptance, and launch gate
- evidence browser for Auth, financial authority, infrastructure, Outcome/Math/Certification packs, and runtime QA results
- operator roles and permissions for high-risk management actions
- audit trail for approvals, overrides, configuration changes, and emergency operations
- read-only production diagnostics where safe
- explicit disabled-state UI for deferred features
- release/runbook links surfaced from the operator workspace

P0-006 must not hide incomplete production capabilities behind polished UI. If a
capability is not launch-ready, the management surface should say so clearly.

## 6. Credit-Only Launch / Cashier Deferred Decision

Current governance posture:

- The first launch path may be credit-only.
- Real-money cashier/provider integration can remain deferred if business and compliance approve that launch posture.
- Cashier atomic completion and worker handling exist as platform foundations, but live deposits/withdrawals require separate provider, reconciliation, support, and compliance readiness.
- Player-facing cashier UX should not be exposed until the cashier launch decision is complete.

Decision required:

| Decision | Options | Recommendation |
| --- | --- | --- |
| Launch money mode | Credit-only, cashier-enabled, or hybrid | Prefer credit-only for first controlled launch unless real-money provider operations are fully certified. |
| Cashier timeline | Pre-launch, beta-after-stability, or post-launch | Keep cashier deferred until production operations has proven reconciliation, incident handling, and support workflows. |
| UI exposure | Hidden, disabled with explanation, or active | Hide or hard-disable cashier surfaces until approved. |

## 7. UI Roadmap

UI work should follow operational safety, not visual convenience.

Priority order:

1. Platform management console for readiness, approvals, evidence, and launch controls.
2. Operations console for health/readiness, queues/DLQ, migrations, incidents, reconciliation, and authority status.
3. Admin configuration UI for markets, games, limits, user roles, and service settings.
4. Agent/operator workflow UI for account management, credit operations, settlement review, and reporting.
5. Player-facing launch UI only after product, credit/cashier, support, and monitoring decisions are approved.
6. Cashier UI only after the cashier deferred decision is closed.

UI principles:

- show authority posture explicitly
- fail closed on unknown permissions or unavailable services
- surface evidence and audit references for high-risk actions
- separate launch-ready features from deferred placeholders
- avoid creating apparent production readiness where operations are incomplete

## 8. Production Operations

Production operations still need final launch evidence for:

- managed PostgreSQL credentials, TLS posture, backup/PITR, restore rehearsal, and migration approval
- managed Redis configuration, authentication, TLS posture, and failover expectations
- CloudAMQP topology, DLQs, replay policy, alarms, and management access controls
- Cloudflare DNS, TLS, WAF/rate-limit posture, origin protection, and Caddy origin behavior
- secret manager integration with Infisical or Doppler
- Grafana Cloud dashboards, alerts, log redaction verification, and on-call routing
- release evidence, image tags, SBOMs, scans, and rollback procedure
- incident response runbooks for auth, settlement, ledger, credit, queues, migrations, and infrastructure
- financial reconciliation operating cadence
- certification pack export and retention process

## 9. Future Expansion

Expansion work must remain downstream from launch safety.

Future areas:

- additional game families and product-specific manifests
- production Outcome Authority activation
- production RNG provider selection, certification, and monitoring
- external result feeds and comparison engine
- laboratory certification submission automation
- richer regulatory evidence exports
- player portal, mobile-first wager flows, and ticket history
- cashier provider integrations
- promotions/freeplay/bonus systems
- advanced BI and forecasting
- multi-market localization and jurisdiction overlays
- hardware RNG or external entropy source support if required

## 10. Deferred Items

Deferred items are intentionally not launch blockers unless selected for the
first launch scope.

| Item | Category | Deferred Until |
| --- | --- | --- |
| Production OAuth/OIDC ecosystem | Authentication | External clients or formal OIDC relying parties are required. |
| Legacy auth retirement | Authentication | Auth Service cutover proves stable with rollback window completed. |
| Real-money cashier provider | Financial Operations | Credit-only launch decision is reversed or cashier is approved for launch. |
| Production Outcome Authority | Game Integrity | RNG provider certification, signing, monitoring, and lab evidence are complete. |
| Production Math Authority integration with Settlement | Game Integrity / Settlement | Outcome and Math certificates are approved for production authority. |
| Certification PDF/lab export | Compliance | External laboratory submission process is selected. |
| Player portal | UI | Platform management and operations surfaces are stable. |
| Advanced analytics dashboards | BI | Core operational dashboards are complete. |
| Kubernetes/Terraform/Helm | Infrastructure | Compose-on-VM v1 limit is exceeded. |

## 11. Architecture Principles

Standing principles:

- Outcome Authority never knows money.
- Math Authority never generates randomness.
- RTP is never controlled by RNG.
- Settlement never changes outcomes.
- Ledger is immutable financial truth.
- Every authority produces signed or hash-linked evidence.
- Production artifacts are immutable and versioned.
- No production placeholders.
- Simulation can never be production authority.
- Jurisdiction is an optional policy overlay unless a specific launch profile requires it.
- Defaults should fail closed for production.
- Local runtime may be convenient; production runtime must be explicit.
- SERVICE authority must be earned through guardrails, evidence, and rollback readiness.

## 12. Platform Decisions

Recorded platform decisions:

| Decision | Current Position |
| --- | --- |
| v1 deployment target | RackNation VM with Docker Compose. |
| Production database | Managed PostgreSQL, not self-hosted. |
| Production Redis | Managed Redis, not self-hosted. |
| Production RabbitMQ | CloudAMQP, not self-hosted. |
| Reverse proxy | Caddy behind Cloudflare. |
| Secret manager | Infisical or Doppler, final selection open. |
| Observability | Grafana Cloud with OpenTelemetry collector. |
| Container registry | GitHub Container Registry. |
| CI/CD | GitHub Actions with immutable image tags. |
| Production migration posture | Approval-gated with staging rehearsal, drift detection, backup/PITR precheck, and evidence output. |
| Initial financial launch posture | Credit-only is preferred unless cashier is explicitly approved. |
| Authority defaults | Conservative defaults; MONOLITH or disabled unless guardrails and approvals allow SERVICE. |

## 13. Open Decisions Register

| ID | Decision | Owner | Needed By | Notes |
| --- | --- | --- | --- | --- |
| ODR-001 | Infisical vs Doppler | Platform / Operations | Before production deployment rehearsal | Must support audit, rotation, environment separation, and GitHub Actions integration. |
| ODR-002 | Credit-only launch approval | Business / Compliance / Operations | Before UI launch scope freeze | Determines whether cashier UI and provider integration remain hidden. |
| ODR-003 | First launch market and jurisdiction posture | Business / Compliance | Before P0-007 | Drives optional jurisdiction overlays and required regulatory evidence. |
| ODR-004 | Production authority defaults at beta | Engineering / Operations | Before P0-010 | Decide whether any Ledger/Credit/Settlement SERVICE authority is enabled at launch. |
| ODR-005 | Production RNG strategy | Engineering / Compliance | Before production Outcome Authority | Choose external provider, OS CSPRNG, DRBG, hardware entropy, or certified hybrid. |
| ODR-006 | Certification pack review process | Compliance / Operations | Before production game activation | Define who accepts packs and where evidence is retained. |
| ODR-007 | Staging environment ownership | Operations | Before P0-008 | Assign environment, credentials, data policy, and teardown rules. |
| ODR-008 | On-call and incident response ownership | Operations | Before production deployment | Required for launch approval. |
| ODR-009 | Player portal launch timing | Product / Operations | Before UI roadmap execution | Should follow platform management and operations UI. |
| ODR-010 | Cashier provider selection | Business / Finance / Compliance | Before cashier launch | Deferred if credit-only launch is approved. |

## 14. Ideas Parking Lot

These ideas are useful, but they should not interrupt the P0 path unless
promoted through planning:

- certification pack viewer with diff and evidence timeline
- replay fixture explorer for Outcome and Math Authority
- launch readiness scorecard with blocker drill-down
- authority graph visualization
- regulator-facing read-only export portal
- operator incident timeline builder
- queue replay simulator
- game manifest marketplace-style catalog
- payment provider abstraction comparison matrix
- automated lab submission bundle generator
- synthetic load generation from certification fixtures
- player-friendly ticket proof/evidence receipt
- mobile agent console
- localized market launch templates

## 15. Register Maintenance

This register should be updated when:

- a P0 milestone is completed
- a deferred item becomes in-scope
- a launch decision is approved or rejected
- a production blocker is discovered
- a platform decision changes
- an idea is promoted into a planned phase

Every update should preserve the distinction between completed evidence,
remaining required work, intentionally deferred work, and parked ideas.
