# Phase 13.1 - Distributed Service Extraction Hardening

## Purpose

Phase 13.1 hardens the monolith boundaries for future extraction of Ledger Service, Credit Wallet Service, and Settlement Service. It does not move production traffic, change financial math, or replace current monolith execution paths.

## Boundary Audit

| Finding | Area | Severity | Remediated In Phase | Notes |
| --- | --- | --- | --- | --- |
| Routes for ledger and credit use service modules rather than repositories. | Ledger/Credit | Low | Yes | Existing route shape is already aligned. |
| No direct ledger, credit, or settlement repository imports were found in `app/api`. | Routes | Low | Yes | Added QA guard to detect regression. |
| QA harnesses read and write financial tables directly for deterministic setup and assertions. | QA | Low | Deferred | Acceptable for test-only scripts; production code remains service-oriented. |
| Reconciliation reads tickets, credit reservations, settlements, accounting snapshots, commissions, and ledger records directly. | Reconciliation | Medium | Deferred | Intentional read-only control-plane coupling. Future extraction should consume read models or service queries. |
| Audit reads source financial tables directly to reconstruct trails. | Audit | Medium | Deferred | Intentional read-only audit coupling. Future extraction should preserve an audit read model. |
| Settlement still has in-memory legacy ledger transaction helpers. | Settlement/Ledger | High | Deferred | This is a blocker for full extraction, but changing it would risk settlement behavior. |
| Settlement applies credit effects through `settlement-credit.service.ts`, which calls the Credit service layer. | Settlement/Credit | Low | Yes | This is the correct adapter pattern for now. |
| Domain repositories were importable as ordinary modules without usage guidance. | All three domains | Medium | Yes | Added comments marking repositories as domain-internal persistence adapters. |

## Preferred Internal Entry Points

Ledger boundary:

- `postLedgerEntry`
- `reverseLedgerEntry`
- `getLedgerTransaction`
- `getLedgerAuditTrail`

Implemented at:

- `src/domains/ledger/ledger.entrypoints.ts`

Credit Wallet boundary:

- `reserveCreditExposure`
- `releaseCreditExposure`
- `applyCreditSettlement`
- `getPlayerCreditSummary`
- `cancelCreditReservation`

Implemented at:

- `src/domains/credit/credit.entrypoints.ts`

Settlement boundary:

- `executeSettlement`
- `resumeSettlement`
- `applySettlementResults`
- `reverseSettlementRecordsForResettlement`
- `executeResettlement`

Implemented at:

- `src/domains/settlement/settlement.entrypoints.ts`

## Coupling Fixed

- Added explicit entrypoint modules for Ledger, Credit Wallet, and Settlement.
- Added `getLedgerTransaction` to the Ledger service so transaction lookup does not require repository imports by callers.
- Added `cancelCreditReservation` to the Credit service using the existing `cancel_credit_reservation` RPC.
- Added repository comments that define repositories as domain-internal persistence adapters.
- Added automated QA guard for missing entrypoints, missing contract docs, and direct route/worker repository imports.

## Coupling Deferred

- Reconciliation and audit read models still query multiple domain tables directly. This is acceptable in the monolith but should become a control-plane read model before services own independent databases.
- Settlement legacy ledger helpers are still in-process and in-memory. Full extraction should first move settlement financial effects behind the hardened Ledger boundary.
- QA scripts still perform direct setup and assertion reads. They should remain out of runtime paths.

## Extraction Readiness Matrix

| Capability | Ledger | Credit Wallet | Settlement |
| --- | --- | --- | --- |
| Data ownership clarity | PARTIAL | PARTIAL | PARTIAL |
| API/command boundary | PARTIAL | PARTIAL | PARTIAL |
| Idempotency | READY | READY | PARTIAL |
| Outbox/event coverage | PARTIAL | READY | PARTIAL |
| Repository isolation | PARTIAL | PARTIAL | PARTIAL |
| Test coverage | PARTIAL | PARTIAL | PARTIAL |
| Operational metrics | PARTIAL | PARTIAL | PARTIAL |
| Rollback path | READY | READY | READY |
| Migration complexity | PARTIAL | PARTIAL | BLOCKED |

Overall:

- Ledger: PARTIAL
- Credit Wallet: PARTIAL
- Settlement: BLOCKED

## Contract Stabilization

Contract documents created:

- `docs/architecture/service-contract-ledger.md`
- `docs/architecture/service-contract-credit-wallet.md`
- `docs/architecture/service-contract-settlement.md`

Each contract documents command inputs, outputs, idempotency requirements, correlation ID expectations, actor expectations, emitted events, failure modes, retry safety, and future endpoint mapping.

## Boundary Guardrails

Lightweight guardrails added:

- Domain entrypoint modules.
- Repository usage comments.
- QA script scanning route and worker code for direct repository imports.

No brittle ESLint import restrictions were added in this phase because the current codebase has active service-boundary evolution and several legitimate read-only control-plane modules.

## Validation Checklist

- Service entrypoint files exist.
- Contract docs exist.
- Routes and worker scripts do not import Ledger, Credit, or Settlement repositories directly.
- Runtime financial, credit, settlement, accounting, and commission math unchanged.
- Production traffic remains in the monolith.
- No .NET traffic routing changes.
