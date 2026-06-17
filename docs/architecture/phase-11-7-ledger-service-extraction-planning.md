# Phase 11.7 Ledger Service Extraction Planning

## 1. Purpose

This document plans a future Ledger Service extraction without moving runtime code in this phase.

The goal is to define ownership, contracts, migration stages, validation expectations, and rollback boundaries before any ledger logic is moved out of the current Next.js modular monolith. The plan preserves the existing hardened financial posting model where Postgres RPCs perform atomic ledger entry insertion and wallet balance updates.

No business behavior changes are included in Phase 11.7.

## 2. Current ledger architecture

The current platform is a Next.js and TypeScript modular monolith backed by Supabase/Postgres. Ledger posting is hardened through database-side financial posting RPCs.

The current ledger architecture follows these principles:

- Ledger entries are immutable.
- Wallet balance is materialized state.
- Ledger entry insertion and wallet balance updates are atomic inside Postgres.
- Idempotency prevents duplicate financial posting.
- TypeScript callers use the ledger service/repository boundary rather than directly calculating `balance_after`.
- Corrections use reversal entries rather than ledger edits or deletes.
- Outbox events support asynchronous event publication after domain state changes.

The database remains the source of truth for financial ledger state.

## 3. Target Ledger Service ownership

The future Ledger Service owns:

- Financial ledger posting interface.
- Financial ledger reversal interface.
- Ledger entry query interface.
- Ledger event contract.
- Ledger audit traceability.

Initial ownership is interface-level ownership. In the first extraction stage, the Ledger Service wraps the existing hardened Postgres RPCs and does not independently calculate balances.

## 4. Explicit non-ownership

The future Ledger Service does not own:

- Wallet business policy.
- Cashier approval lifecycle.
- Settlement result calculation.
- Player account lifecycle.
- Commission calculation.
- Accounting weekly close.
- Authentication.

Those concerns remain with their current domains or future dedicated services. The Ledger Service should receive validated posting requests and enforce ledger posting integrity, but it should not decide whether a cashier transaction, settlement result, commission, or account lifecycle transition is valid.

## 5. Database migration strategy

Stage 1: Shared Postgres.

- The Ledger Service uses the existing shared Postgres database.
- Existing hardened financial posting RPCs remain the source of truth.
- The service calls existing RPCs for posting and reversal behavior.
- No independent balance calculation is allowed in the service.
- No data ownership transfer occurs yet.

Stage 2: Service-owned ledger schema.

- Ledger tables and RPCs move toward a service-owned schema boundary.
- Monolith access is reduced to service contracts or approved read-only projections.
- Contract tests, reconciliation jobs, audit trails, and operational dashboards must exist before the schema boundary is hardened.
- Existing data remains compatible with the current ledger model.

Stage 3: Independent Ledger database.

- A separate Ledger database is considered only after contracts, reconciliation, monitoring, and rollback are proven.
- Cross-service workflows must be idempotent.
- Event replay and reconciliation must be operationally validated.
- Rollback procedures must be tested before production cutover.

## 6. API contract candidates

Candidate HTTP endpoints for the future Ledger Service:

- `POST /ledger/entries`
- `POST /ledger/entries/{id}/reverse`
- `GET /ledger/entries/{id}`
- `GET /ledger/accounts/{accountId}/entries`
- `GET /ledger/health`

`POST /ledger/entries` should accept a validated posting command and pass it to the existing database RPC during Stage 1. It must not calculate wallet balances itself.

`POST /ledger/entries/{id}/reverse` should create reversal entries through the same atomic posting path used by normal ledger entries.

Query endpoints should expose ledger records and audit-relevant metadata without allowing mutation of existing ledger rows.

## 7. Event contract candidates

Candidate ledger events:

- `ledger.entry.posted`
- `ledger.entry.reversed`
- `ledger.posting.rejected`

Events must be idempotent and include correlation metadata. Event payloads should identify the ledger entry, account, wallet, transaction type, direction, amount, currency, reference, idempotency key where available, and audit context.

Rejected posting events should avoid leaking sensitive operational details while retaining enough metadata for support, reconciliation, and incident review.

## 8. Current monolith flow

Current financial posting flow:

1. A domain flow, such as cashier completion or manual adjustment, validates domain-specific rules.
2. The monolith calls the ledger service boundary.
3. The ledger repository calls the hardened Postgres posting RPC.
4. The RPC locks the wallet row.
5. The RPC checks idempotency.
6. The RPC calculates the resulting wallet balance.
7. The RPC inserts an immutable ledger entry.
8. The RPC updates the wallet balance atomically.
9. The caller receives the ledger entry.
10. Domain-specific events may be recorded through the outbox where applicable.

No TypeScript financial posting path should insert a ledger row and then update wallet balance outside the RPC.

## 9. Future extracted flow

Future Stage 1 extracted flow:

1. A domain flow validates domain-specific rules in the monolith.
2. The monolith sends a ledger posting request to the Ledger Service.
3. The Ledger Service validates request shape, idempotency key presence where required, correlation metadata, and contract-level constraints.
4. The Ledger Service calls the existing hardened Postgres RPC.
5. The RPC remains responsible for locking, idempotency, balance calculation, ledger insertion, and wallet balance update.
6. The Ledger Service returns the ledger entry response.
7. The Ledger Service emits or records ledger events according to the approved event contract.
8. The monolith continues its domain workflow using the returned ledger entry.

The Ledger Service initially wraps existing RPCs. It must not independently calculate balances.

## 10. Wallet/Cashier/Settlement interaction rules

Wallet interaction rules:

- Wallet balances remain materialized state owned by the database posting path during Stage 1.
- The Ledger Service may request posting through RPCs but must not bypass wallet locks.
- The Ledger Service must not cache financial balances in Redis.
- Wallet status and business policy remain outside Ledger Service ownership.

Cashier interaction rules:

- Cashier approval lifecycle remains in the cashier domain.
- Cashier completion may request ledger posting after cashier rules pass.
- The Ledger Service does not approve, reject, or lifecycle-manage cashier transactions.

Settlement interaction rules:

- Settlement result calculation remains in the settlement domain.
- Settlement may request ledger postings for approved settlement outcomes.
- The Ledger Service does not determine winning outcomes, prize values, or settlement eligibility.

Shared interaction rules:

- All callers must use idempotency keys for financial posting commands.
- All callers must propagate correlation IDs.
- Reversal entries are used for corrections.
- Existing immutable ledger guarantees must be preserved.

## 11. Cutover plan

1. Documentation complete.
2. Contracts reviewed.
3. Ledger Service created from `dotnet-template-service`.
4. Service calls existing RPCs.
5. Shadow mode logging.
6. Feature flag controlled routing.
7. Gradual traffic switch.
8. Monolith fallback.
9. Reconciliation pass.
10. Final ownership transfer only after validation.

During shadow mode, the service should observe and log intended requests without becoming the source of production posting decisions. Any divergence between monolith posting behavior and service contract interpretation must block cutover.

## 12. Rollback plan

Rollback requirements:

- Feature flag back to monolith.
- No data migration rollback required in Stage 1.
- Existing RPCs remain intact.
- Events remain idempotent.
- Reconciliation report required after rollback.

In Stage 1, rollback is operational rather than structural because the Ledger Service wraps the same source-of-truth RPCs. If the extracted route fails, traffic returns to the monolith ledger boundary and the database posting model remains unchanged.

## 13. Reconciliation requirements

Reconciliation must prove:

- Every successful ledger posting request has one immutable ledger entry.
- Idempotent retries return the same ledger entry and do not create duplicates.
- Wallet materialized balances equal the sum of ledger effects for each wallet.
- Reversal entries point to the original ledger entry.
- Cashier-linked ledger entries match completed cashier transactions.
- Settlement-linked ledger entries match finalized settlement results.
- Outbox or ledger events match committed ledger entries.
- Correlation IDs allow traceability across monolith, service, database, and queue logs.

Reconciliation reports should be generated before cutover, during shadow mode, after gradual traffic shifts, and after rollback if rollback occurs.

## 14. Risks and mitigations

Risk: duplicated balance calculation.

Mitigation: Stage 1 Ledger Service must call existing RPCs and must not calculate balances independently.

Risk: split ownership between wallet policy and ledger posting.

Mitigation: keep wallet business policy outside Ledger Service ownership and document caller responsibilities in service contracts.

Risk: duplicate financial posting during retries.

Mitigation: require idempotency keys for posting commands and preserve existing RPC idempotency behavior.

Risk: event contract drift.

Mitigation: version event contracts, validate payloads, and reconcile events against committed ledger entries.

Risk: difficult rollback after schema or database separation.

Mitigation: keep Stage 1 on shared Postgres, prove contracts and reconciliation first, and delay independent database ownership until rollback is tested.

Risk: callers bypass the Ledger Service or RPC.

Mitigation: audit code paths, restrict write access over time, and add contract tests around approved posting interfaces.

## 15. Validation checklist

- Documentation file exists at `docs/architecture/phase-11-7-ledger-service-extraction-planning.md`.
- Git diff confirms docs-only change for Phase 11.7.
- No Docker changes.
- No API behavior changes.
- No database changes.
- No ledger logic changes.
- No wallet logic changes.
- No cashier logic changes.
- No settlement logic changes.
- No outbox behavior changes.
- No auth changes.
- No real Ledger .NET service created.
- Future extraction plan states that the Ledger Service initially wraps existing RPCs.
- Future extraction plan states that the Ledger Service must not independently calculate balances.
