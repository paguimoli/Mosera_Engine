# Phase 11.13 Credit Launch Readiness Gap Analysis

## 1. Executive Summary

Overall readiness for a controlled North American credit-based launch: Not Ready.

The platform has meaningful foundations: modular Next.js domains, Supabase/Postgres schema foundations, hardened ledger posting RPCs, RabbitMQ, Redis, Docker Compose, health checks, outbox infrastructure, service skeletons, hierarchy tables, wallet tables, ticket/settlement foundations, weekly accounting foundations, and commission foundations. These are useful, but they are not yet sufficient for a controlled credit beta.

Major area assessment:

| Area | Readiness | Rationale |
| --- | --- | --- |
| Architecture | Partially Ready | Modular monolith and service-boundary planning exist; Ledger and Credit Wallet services are skeletons only. |
| Infrastructure | Partially Ready | Docker, RabbitMQ, Redis, health routes, outbox, and service containers exist; production monitoring/runbooks are incomplete. |
| Hierarchy | Partially Ready | Super Master, Master, Agent, Player account model exists; visibility, movement audit, and exposure ownership are not beta-ready. |
| Credit | Not Ready | Credit wallet concepts and skeleton service exist, but no first-class reservation, release, settlement, or reconciliation workflow exists. |
| Tickets | Partially Ready | Ticket creation/storage foundations exist; credit reservation, durable grading integration, and reports are incomplete. |
| Draws | Partially Ready | Draw/game UI and data foundations exist; operational draw lifecycle controls and production-grade metrics are incomplete. |
| Settlement | Partially Ready | Evaluators, recovery, resettlement concepts, and ledger integration foundations exist; credit settlement flow is not wired. |
| Accounting | Partially Ready | Weekly period and summary foundations exist; zero-balance/carry/credit statement flows are placeholders. |
| Commissions | Partially Ready | Plan/rule/assignment foundations exist; generated weekly records are placeholder-based and payout posting is absent. |
| Reporting | Not Ready | Architecture docs exist, but operator launch reports are not complete enough for beta operations. |
| QA | Not Ready | Required end-to-end, concurrency, reconciliation, and hierarchy tests are not yet present at launch depth. |
| Operations | Partially Ready | Health/logging foundations exist; support tooling, alerting, runbooks, and incident workflows are incomplete. |

Recommendation: do not begin controlled beta until Priority 1 blockers in this document are complete and reconciled with real test data.

## 2. Current Architecture Inventory

| Component | Current State | Implemented vs Planned |
| --- | --- | --- |
| Next.js app | Main modular monolith with API routes and domain modules. | Implemented foundation; still carrying production business ownership. |
| Supabase | Primary backend integration. | Implemented for current app; manual migration/application validation still required. |
| PostgreSQL | Accounts, wallets, ledger, cashier, weekly accounting, commissions, outbox/idempotency/job foundations exist. | Implemented foundation; credit reservation/exposure schema is missing. |
| RabbitMQ | Docker service, publisher/consumer abstractions, dev consumer, outbox dispatch integration. | Implemented infrastructure foundation; operational monitoring not complete. |
| Redis | Docker service, URL config, lightweight health/client foundation. | Implemented infrastructure foundation; not used for business logic, correctly. |
| Docker | App, RabbitMQ, Redis, .NET template, Ledger Service, Credit Wallet Service compose foundation. | Implemented local runtime foundation; production deployment hardening not complete. |
| Ledger Service | .NET 10 skeleton with contract routes and health. | Planned service shell only; does not own production posting. |
| Credit Wallet Service | .NET 10 skeleton with contract routes and health. | Planned service shell only; no production credit operations. |
| Auth | Auth/MFA/OAuth/RBAC schema and routes exist. | Implemented foundation; hierarchy-scoped visibility must be verified for launch. |
| Settlement | Domain modules for evaluators, execution, recovery, resettlement, and ledger posting exist. | Partial; credit wallet reserve/release/settle integration is missing. |
| Accounting | Weekly accounting periods/summaries exist. | Partial; credit statements, zero-balance ledger entries, carry workflows, and reconciliation are incomplete. |
| Commission | Plans, rules, assignments, rollups, and weekly records exist. | Partial; launch-grade commission calculations and postings are incomplete. |
| Reporting | Architecture documentation exists. | Mostly planned; operator reports are not launch-ready. |

## 3. Launch Workflow Analysis

| Step | Classification | Rationale |
| --- | --- | --- |
| Super Master | Partial | Account type exists; full operational dashboards, hierarchy visibility, and exposure controls are not complete. |
| Master | Partial | Master account type and hierarchy validation exist; allocation/exposure ownership is not fully enforced. |
| Agent | Partial | Agent account type, commission assignment, and player parent rules exist; launch reporting and exposure controls are incomplete. |
| Player | Partial | Player accounts/profiles and wallets exist; player credit lifecycle is not first-class. |
| Credit Assignment | Missing | Credit limit fields exist, but no authoritative Credit Wallet Service operation or allocation flow exists. |
| Ticket Placement | Partial | Ticket creation foundation exists; it does not atomically reserve credit exposure before acceptance. |
| Draw Lifecycle | Partial | Draw/game foundations exist; production close/result controls and metrics are incomplete. |
| Result Posting | Partial | UI/data foundations exist; operational audit, permissions, and settlement trigger hardening need verification. |
| Settlement | Partial | Settlement engine foundations exist; credit release and balance impact are not wired to Credit Wallet Service. |
| Weekly Accounting | Partial | Periods and summaries exist; summaries use placeholder values and do not fully reconcile credit activity. |
| Commission Calculation | Partial | Commission foundation exists; weekly records can be generated as placeholders and payout posting is absent. |
| Reporting | Missing | Required launch reports for player/agent/master figures and exposure are incomplete. |

## 4. Hierarchy Readiness

| Capability | Super Master | Master | Agent | Player | Classification |
| --- | --- | --- | --- | --- | --- |
| Creation | Exists through account foundations. | Exists. | Exists. | Exists. | Partial |
| Editing | Exists through account routes/domain. | Exists. | Exists. | Exists. | Partial |
| Movement | Parent validation exists. | Parent validation exists. | Parent validation exists. | Parent validation exists. | Partial |
| Permissions | RBAC permissions exist. | RBAC permissions exist. | RBAC permissions exist. | RBAC permissions exist. | Partial |
| Visibility | Not fully proven. | Not fully proven. | Not fully proven. | Not fully proven. | Missing/Partial |
| Credit ownership | Not implemented. | Not implemented. | Not implemented. | Credit limit exists but ownership flow is missing. | Missing |
| Exposure ownership | Not implemented. | Not implemented. | Not implemented. | Current exposure exists in legacy-style models, not first-class reservations. | Missing |
| Auditability | Basic timestamps and integrity foundations exist. | Basic. | Basic. | Basic. | Partial |

Key gaps:

- No launch-grade hierarchy-scoped exposure dashboard.
- No formal credit allocation workflow.
- No audit trail for hierarchy movement impact on credit/exposure.
- No verified visibility matrix for Super Master, Master, Agent, and Player views.

## 5. Credit Readiness

| Capability | Classification | Rationale |
| --- | --- | --- |
| Credit limits | Partial | `credit_limit` exists on financial wallets and account forms include credit values, but no authoritative command workflow exists. |
| Available credit | Partial | Helpers calculate simple available credit, but locked formula with pending exposure is not implemented end to end. |
| Pending exposure | Missing | No first-class persisted reservation/release lifecycle exists. |
| Credit adjustments | Partial | Ledger transaction types exist for manual credit/debit adjustments; no launch-grade Credit Wallet adjustment workflow exists. |
| Statements | Missing | Weekly summaries exist, but player credit statements are not complete. |
| Reconciliation | Missing | No automated credit wallet versus ledger/tickets/settlement/accounting reconciliation suite. |
| Weekly carry | Partial | Summary fields include carry concepts; calculation and operations are placeholder-level. |
| Weekly zero balance | Partial | Accounting comments explicitly defer zero-balance ledger entries. |

Credit launch status: Not Ready.

## 6. Ticket Lifecycle Readiness

| Capability | Classification | Rationale |
| --- | --- | --- |
| Ticket creation | Partial | Ticket payload construction and API route exist. |
| Ticket storage | Partial | Ticket domain/repository exists; launch persistence and reporting must be verified with real beta flows. |
| Ticket lookup | Partial | Lookup UI/API foundations exist. |
| Ticket grading | Partial | Settlement evaluators exist; full draw/result/ticket integration must be hardened. |
| Ticket settlement | Partial | Settlement execution exists; credit exposure release and balance impact are missing. |
| Ticket audit | Partial | Integrity hash foundation exists; operational audit trail is incomplete. |
| Ticket reporting | Missing | Operator-ready ticket, exposure, and settlement reports are incomplete. |

Critical gap: ticket acceptance is not gated by an atomic credit reservation.

## 7. Draw Readiness

| Capability | Classification | Rationale |
| --- | --- | --- |
| Draw generation | Partial | Draw/game foundations and UI state exist. |
| Draw closure | Partial | Permissions and lifecycle concepts exist; production controls need verification. |
| Result posting | Partial | Result fields and settlement paths exist; audit, permissions, and operational controls need hardening. |
| Draw metrics | Partial | Some metrics fields exist; monitoring/reporting is incomplete. |
| Keno support | Partial | Keno/hotspot concepts and quick-pick route exist. |
| Lottery support | Partial | Lottery-style ticket/draw foundations exist. |

Draw launch status: Partially Ready.

## 8. Settlement Readiness

| Capability | Classification | Rationale |
| --- | --- | --- |
| Settlement logic | Partial | Evaluator router, execution, and settlement records exist. |
| Reversal support | Partial | Resettlement/reversal concepts exist; production workflows and ledger linkage need hardening. |
| Resettlement support | Partial | Resettlement modules exist; operator controls and reconciliation are incomplete. |
| Auditability | Partial | Integrity foundations exist; launch-grade audit trails need completion. |
| Ledger integration | Partial | Settlement ledger service exists; credit wallet settlement path is not wired. |

Critical gap: settlement does not call a production Credit Wallet reserve/release/settle authority.

## 9. Financial Readiness

This is credit launch readiness, not cash readiness.

| Capability | Classification | Rationale |
| --- | --- | --- |
| Ledger | Partial | Hardened RPC posting exists and Ledger Service shell exists; credit-specific posting rules are not fully wired. |
| Wallet | Partial | Financial wallets support CREDIT and credit limits; reservation/exposure state is missing. |
| Accounting | Partial | Weekly period and summary foundation exists; values are placeholders for settled result, exposure, ticket counts, and zero-balance entries. |
| Commissions | Partial | Plan/rule/assignment foundations exist; weekly commission records are placeholder-generated and payout ledger entries are absent. |
| Statements | Missing | Player/agent/master credit statements are not launch-ready. |
| Reconciliation | Missing | No complete credit reconciliation workflow exists. |

Positive note: cashier cash flows are explicitly not part of this launch model and should remain disabled/out of scope for beta.

## 10. Operational Readiness

| Capability | Classification | Rationale |
| --- | --- | --- |
| Admin workflows | Partial | Account, wallet, market, brand, commission, cashier, and worker routes exist; credit operations are not launch-grade. |
| Monitoring | Partial | Health endpoints exist; metrics/alerts/dashboards are incomplete. |
| Logging | Partial | Structured logging foundation exists; correlation must be proven across all launch workflows. |
| Health checks | Partial | App, DB, Redis, .NET skeletons have health foundations; production dependency readiness needs hardening. |
| Audit trails | Partial | Integrity hash and ledger foundations exist; full operator audit trails are incomplete. |
| Error handling | Partial | Domain errors exist in places; user/operator support error model is inconsistent across workflows. |
| Support tooling | Missing | No complete support console for reservation, settlement, correction, reconciliation, or hierarchy investigation. |

## 11. Reporting Readiness

Operator needs:

| Report | Classification | Rationale |
| --- | --- | --- |
| Player figures | Missing | No complete player credit statement/report. |
| Agent figures | Missing | Commission rollups exist, but operator-ready reports are not complete. |
| Master figures | Missing | Hierarchy aggregates require validation and reporting UI/API. |
| Weekly figures | Partial | Weekly summaries exist with placeholder values. |
| Exposure | Missing | First-class pending exposure reservations are missing. |
| Settlement reports | Partial | Settlement records exist; launch reporting is incomplete. |
| Commission reports | Partial | Commission records exist; calculations/postings need completion. |

Reporting launch status: Not Ready.

## 12. QA Readiness

Required test suites:

| Suite | Current State | Missing |
| --- | --- | --- |
| Hierarchy tests | Partial domain validation likely covered informally. | Full creation/edit/move/visibility matrix tests. |
| Credit tests | Missing. | Limit, available credit, reserve, release, settle, adjust, concurrency, idempotency. |
| Ticket tests | Partial. | Ticket acceptance with credit reservation and rejection cases. |
| Settlement tests | Partial. | Credit release/settle integration, reversal, resettlement, failed settlement recovery. |
| Ledger tests | Partial. | Credit-specific ledger integration and reconciliation tests. |
| Accounting tests | Partial. | Weekly carry, zero balance, summaries from real ticket/settlement data. |
| Commission tests | Partial. | Commission calculation against weekly credit figures and hierarchy rollups. |
| End-to-end tests | Missing. | Super Master -> Master -> Agent -> Player -> Credit -> Ticket -> Draw -> Settlement -> Accounting -> Commission -> Reporting. |
| Operational tests | Missing. | Outage, retry, idempotency replay, support correction, rollback, audit retrieval. |

QA launch status: Not Ready.

## 13. Critical Launch Blockers

1. No atomic credit reservation at ticket placement.
2. No first-class pending exposure persistence and release lifecycle.
3. Credit Wallet Service is a skeleton and does not own production credit operations.
4. Settlement does not apply credit release and balance impact through a controlled credit authority.
5. Weekly accounting summaries do not calculate real settled credit results, exposure, or ticket counts.
6. Zero-balance weekly reset is explicitly deferred and does not post ledger/audit entries.
7. Commission records are placeholder-level and not driven by final weekly credit figures.
8. Operator reporting for player/agent/master figures and exposure is incomplete.
9. No automated reconciliation across credit wallets, ledger, tickets, settlement, weekly accounting, and commissions.
10. No launch-grade QA suite for hierarchy, credit, tickets, settlement, accounting, commissions, and end-to-end operations.

## 14. High-Risk Areas

| Area | Rank | Risk |
| --- | --- | --- |
| Credit reservation concurrency | High | Concurrent ticket placement could overspend credit without atomic reservation. |
| Pending exposure | High | Exposure may become stale or invisible without first-class lifecycle tracking. |
| Settlement integration | High | Settlement could grade tickets without reliable credit release/balance impact. |
| Weekly accounting | High | Weekly figures could be wrong because summary values are placeholders. |
| Commission calculation | High | Commission basis could be wrong if weekly figures/exposure are incomplete. |
| Reporting | High | Operators may be unable to verify figures during beta. |
| Reconciliation | High | Financial drift may go undetected. |
| Hierarchy visibility | Medium | Users may see too much or too little downline data. |
| Service skeleton confusion | Medium | Operators may assume Ledger/Credit services are active when they are placeholders. |
| Event ordering/replay | Medium | Consumers must be idempotent before relying on event flows operationally. |
| Cashier scope leakage | Low | Cashier exists, but launch model should disable no-cash workflows. |

## 15. Launch Readiness Scorecard

| Area | Score | Notes |
| --- | ---: | --- |
| Architecture | 65% | Strong modular and service-planning foundation. |
| Infrastructure | 70% | Docker/RabbitMQ/Redis/service health exist; ops hardening remains. |
| Hierarchy | 55% | Account hierarchy exists; visibility/exposure ownership incomplete. |
| Credit | 20% | Contracts/skeleton exist; operational credit engine missing. |
| Tickets | 45% | Ticket foundation exists; credit reservation missing. |
| Draws | 50% | Draw foundations exist; operational controls need hardening. |
| Settlement | 50% | Engine foundations exist; credit integration incomplete. |
| Accounting | 35% | Weekly foundations exist; real credit close incomplete. |
| Commissions | 35% | Foundations exist; launch-grade calculation/posting incomplete. |
| Reporting | 25% | Docs and some records exist; operator launch reports missing. |
| QA | 20% | Critical test suites missing. |
| Operations | 45% | Health/logging foundations exist; support tooling and alerting incomplete. |

Estimated overall readiness: 43%.

## 16. Recommended Pre-Beta Roadmap

### Priority 1: Must complete before beta

1. Implement first-class credit reservation, release, settlement, and adjustment flows in the monolith or controlled service path.
2. Persist pending exposure with idempotency and concurrency protection.
3. Gate ticket acceptance on successful full-ticket credit reservation.
4. Wire settlement to release exposure and apply credit balance impact.
5. Produce real weekly credit summaries from ticket, settlement, wallet, and ledger data.
6. Implement zero-balance/carry-balance weekly close rules with ledger/audit entries.
7. Build player, agent, master, and super master exposure/figure reports.
8. Implement reconciliation reports across credit, ledger, tickets, settlement, accounting, and commissions.
9. Build minimum QA suite for the full beta happy path and critical failure paths.
10. Define beta operational controls: support correction flow, rollback, runbook, and alerting.

### Priority 2: Should complete before beta

1. Harden hierarchy visibility and movement audit.
2. Complete commission calculations against real weekly figures.
3. Add operational dashboards for RabbitMQ, outbox, job runs, and credit operations.
4. Add support tooling for stale exposure, failed settlement, duplicate idempotency, and reconciliation exceptions.
5. Add shadow-mode logs for Credit Wallet Service and Ledger Service before routing traffic.
6. Add read-only beta reporting exports for operators.

### Priority 3: Can be completed after beta

1. Move Credit Wallet Service from skeleton to production owner after monolith workflow is proven.
2. Expand service extraction beyond wrapping safe existing paths.
3. Add advanced reporting and BI dashboards.
4. Add broader multi-market and multi-currency launch support.
5. Add deeper automated resettlement tooling.

## 17. Recommended Beta Scope

Recommended first controlled beta:

- Users: 10 to 25 total users.
- Super Masters: 1.
- Masters: 1.
- Agents: 2.
- Players: 10 to 20.
- Markets: 1.
- Brands: 1.
- Currencies: 1.
- Supported games: one lottery/keno-style game only, with a fixed small set of wager types.
- Real-money deposits: disabled.
- Real-money withdrawals: disabled.
- Cashier: disabled or operationally inaccessible for beta users.
- Credit limits: low fixed limits.
- Ticket stake limits: low fixed limits.
- Settlement: supervised only at first.
- Weekly close: dry-run first, then supervised close.
- Commission: calculate-only until reconciled.
- Reporting: daily operator reconciliation mandatory.
- Operational controls: feature flags, manual rollback, audit review, stale exposure report, settlement exception report, and beta incident log.

## 18. Validation Checklist

- Documentation only.
- No runtime code changes.
- No schema changes.
- No service changes.
- No infrastructure changes.
- Documentation file exists at `docs/architecture/phase-11-13-credit-launch-readiness-gap-analysis.md`.
- Git status shows documentation-only changes for this phase.
- `git diff --check` passes.
- No commit created.
- No tag created.

