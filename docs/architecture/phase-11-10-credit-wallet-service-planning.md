# Phase 11.10 Credit Wallet Service Planning

## 1. Purpose

The Credit Wallet Service is the future service boundary for managing player credit in a credit-based betting platform.

Credit is not a secondary or informal system. Credit must be treated with the same architectural rigor as cash:

- Immutable audit trail.
- Idempotency.
- Reconciliation.
- Ledger linkage.
- Service ownership.
- Event contracts.
- Rollback strategy.
- Operational visibility.

The service must manage:

- Credit limits.
- Available credit.
- Used credit.
- Pending exposure.
- Settled results.
- Credit adjustments.
- Credit statement basis.

Credit movement must remain auditable and traceable to the ticket, settlement, adjustment, actor, source service, correlation ID, and ledger/audit record where applicable.

## 2. Service Ownership

The Credit Wallet Service owns:

- Player credit wallet interface.
- Credit limit management interface.
- Available credit calculation interface.
- Pending exposure reservation/release interface.
- Settled credit impact interface.
- Credit adjustment interface.
- Credit wallet query interface.
- Credit wallet event contract.

The Credit Wallet Service does not own:

- Ledger posting authority.
- Cashier real-money deposits/withdrawals.
- Game result calculation.
- Ticket settlement rules.
- Commission calculation.
- Weekly accounting close.
- Authentication.
- Player identity lifecycle.

The service may expose data required by accounting, commission, and reporting domains, but those domains retain their own calculations unless ownership is explicitly reassigned in a later phase.

## 3. Platform Monetary Standard

Credit follows locked Platform Standard #001:

- `amount` is integer minor currency units.
- `currency` is ISO-4217.
- Floating point monetary values are prohibited.

Credit amounts must use the same money standard as cash.

Canonical money shape:

```json
{
  "amount": 1050,
  "currency": "USD"
}
```

Credit Wallet Service contracts must not accept or return floating point monetary values. Formatting is the responsibility of UI, reports, exports, and external integrations.

## 4. Current Architecture

The current platform is a Next.js and TypeScript modular monolith backed by Supabase/Postgres. Cash wallet ledger posting has already been hardened through database-side RPCs that atomically insert immutable ledger entries and update materialized wallet balances.

Current credit-specific implementation details require verification before extraction. Planning assumptions:

- Player wallets and financial ledger entries currently exist in the monolith data model.
- Credit-like behavior may be represented through wallet types, transaction types, settlement flows, weekly accounting, or manual adjustments.
- Ticket placement and settlement currently remain monolith-owned.
- Credit exposure reservation may not yet exist as a dedicated first-class service boundary.
- Weekly accounting and commission flows may consume derived wallet, ledger, ticket, or settlement data.

Assumptions requiring verification:

- Whether pending exposure is persisted separately from wallet balance today.
- Whether credit limit and available credit are modeled separately today.
- Whether zero-balance weekly reset is represented as ledger entries, wallet state updates, accounting period logic, or a combination.
- Whether free play credit is part of the same credit model or a separate promotional balance.
- Which current tables and services calculate agent/master exposure and weekly figures.

No existing behavior is changed by this planning phase.

## 5. Target Architecture

Future flow:

```text
Ticket Service / Settlement / Admin
  -> Credit Wallet Service
  -> Ledger Service
  -> Existing hardened ledger RPCs during initial extraction
  -> Database
  -> Outbox
  -> RabbitMQ
```

Important rule:

The initial Credit Wallet Service must not bypass Ledger Service for financial audit entries.

Initial extraction principles:

- Credit Wallet Service owns credit commands and queries.
- Ledger Service owns immutable financial/audit posting authority.
- During initial extraction, Ledger Service wraps existing hardened ledger RPCs.
- Credit Wallet Service must not directly calculate ledger `balance_after`.
- Credit Wallet Service must not write financial source-of-truth data to Redis.
- Database remains the source of truth until service-owned schemas and reconciliation are proven.

## 6. Credit Concepts

Credit limit:

The maximum credit exposure approved for a player in a specific currency and market context.

Available credit:

The amount of credit currently available for new wagers. A typical calculation is credit limit minus used credit minus pending exposure, adjusted by settlement and carry balance rules. The exact formula must be contractually locked before implementation.

Used credit:

Credit already consumed by settled activity, carry balances, or posted debit impacts.

Pending exposure:

Reserved credit tied to unsettled tickets or open risk. Pending exposure reduces available credit until released or settled.

Settled balance:

The result of settled wins, losses, refunds, voids, or adjustments that have been applied to the credit wallet.

Carry balance:

The balance carried from one accounting period to another when balances are not reset or fully settled at close.

Zero balance weekly reset:

A weekly process that resets applicable credit balances to zero according to business policy. This must be auditable and reconciled through ledger/audit entries, not silent state mutation.

Manual credit adjustment:

An authorized increase or decrease to credit state with actor, reason, correlation ID, idempotency key, and ledger/audit linkage.

Debit adjustment:

An authorized reduction to available or settled credit state, usually used to correct over-crediting, operational errors, or approved account changes.

Free play credit:

Promotional or non-cash betting value, if applicable. Free play credit must be modeled explicitly and must not be mixed with cash or standard credit unless business rules intentionally define that relationship.

## 7. Credit Reservation Flow

Future ticket placement flow:

1. Player submits ticket.
2. Ticket service requests credit reservation.
3. Credit Wallet Service validates available credit.
4. Credit Wallet Service reserves pending exposure.
5. Ledger/audit entry is created where required.
6. Ticket is accepted only after reservation succeeds.
7. Reservation failure rejects ticket.

Reservation rules:

- Reservation must be idempotent by ticket or reservation command key.
- Reservation must be atomic with the persisted pending exposure change.
- Concurrent ticket placement must not overspend available credit.
- Reservation failure must return a clear reason code.
- Reservation success must return reservation ID, player ID, ticket ID, reserved amount, currency, available credit after reservation, and correlation ID.

## 8. Settlement Flow

Future settlement flow:

1. Draw result is posted.
2. Settlement calculates outcome.
3. Settlement requests credit release/settlement.
4. Credit Wallet Service releases exposure.
5. Credit Wallet Service applies win/loss result.
6. Ledger Service records immutable financial/audit entries.
7. Events are emitted.

Settlement rules:

- Settlement domain owns game outcome and ticket settlement decisions.
- Credit Wallet Service owns applying the approved result to credit state.
- Ledger Service records immutable audit/financial entries.
- Duplicate settlement requests must not duplicate releases or settled impacts.
- Settlement mismatch must block completion and require reconciliation.

## 9. Agent / Master Hierarchy Impact

Player credit affects:

- Agent exposure.
- Master exposure.
- Weekly agent figure.
- Weekly master figure.
- Commission calculations.
- Reporting.

Credit Wallet Service should expose data needed for hierarchy accounting, including player exposure, pending exposure, settled credit impact, adjustments, carry balances, and period boundaries.

Credit Wallet Service should not calculate commissions unless explicitly assigned in a later phase. Commission and weekly accounting services may consume credit wallet data, but ownership of commission rules and weekly close remains outside the Credit Wallet Service.

Hierarchy reporting must reconcile:

- Player-level credit state.
- Agent aggregate exposure.
- Master aggregate exposure.
- Settlement results.
- Weekly accounting statements.
- Commission basis.

## 10. API Contract Candidates

### POST /v1/credit-wallets/{playerId}/limit

Purpose: Set or update a player's credit limit.

Caller: Admin, operations, or approved account management service.

Idempotency: Required.

High-level request fields:

- `limit.amount`
- `limit.currency`
- `effectiveAt`
- `reason`
- `actorUserId`
- `metadata`

High-level response fields:

- `playerId`
- `creditWalletId`
- `previousLimit`
- `newLimit`
- `availableCredit`
- `correlationId`

Failure cases:

- Player not found.
- Unsupported currency.
- Invalid amount.
- Unauthorized actor.
- Duplicate idempotency key with different payload.

### POST /v1/credit-wallets/{playerId}/reserve

Purpose: Reserve pending exposure for a ticket.

Caller: Ticket Service.

Idempotency: Required.

High-level request fields:

- `ticketId`
- `reservationId`
- `stake.amount`
- `stake.currency`
- `marketId`
- `drawId`
- `metadata`

High-level response fields:

- `reservationId`
- `playerId`
- `ticketId`
- `reservedAmount`
- `pendingExposure`
- `availableCredit`
- `correlationId`

Failure cases:

- Player not found.
- Credit wallet not active.
- Insufficient available credit.
- Duplicate reservation.
- Unsupported currency.
- Concurrent reservation conflict.

### POST /v1/credit-wallets/{playerId}/release

Purpose: Release pending exposure without applying a win/loss result, such as rejected, canceled, refunded, or voided ticket handling.

Caller: Ticket Service or Settlement Service.

Idempotency: Required.

High-level request fields:

- `reservationId`
- `ticketId`
- `releaseAmount`
- `reason`
- `metadata`

High-level response fields:

- `reservationId`
- `releasedAmount`
- `pendingExposure`
- `availableCredit`
- `correlationId`

Failure cases:

- Reservation not found.
- Reservation already released.
- Release amount exceeds reserved amount.
- Currency mismatch.
- Duplicate release command with different payload.

### POST /v1/credit-wallets/{playerId}/settle

Purpose: Release exposure and apply settlement outcome to credit state.

Caller: Settlement Service.

Idempotency: Required.

High-level request fields:

- `settlementId`
- `ticketId`
- `reservationId`
- `stake`
- `payout`
- `netResult`
- `outcome`
- `metadata`

High-level response fields:

- `settlementId`
- `ticketId`
- `releasedExposure`
- `settledImpact`
- `pendingExposure`
- `availableCredit`
- `ledgerEntryIds`
- `correlationId`

Failure cases:

- Settlement already applied.
- Reservation not found.
- Settlement mismatch.
- Currency mismatch.
- Ledger posting failure.
- Duplicate idempotency key with different payload.

### POST /v1/credit-wallets/{playerId}/adjust

Purpose: Apply manual credit adjustment.

Caller: Admin or operations service.

Idempotency: Required.

High-level request fields:

- `adjustmentType`
- `amount`
- `reason`
- `actorUserId`
- `reference`
- `metadata`

High-level response fields:

- `adjustmentId`
- `playerId`
- `adjustmentType`
- `amount`
- `availableCredit`
- `ledgerEntryIds`
- `correlationId`

Failure cases:

- Invalid adjustment type.
- Invalid amount.
- Unsupported currency.
- Unauthorized actor.
- Ledger posting failure.
- Duplicate idempotency key with different payload.

### GET /v1/credit-wallets/{playerId}

Purpose: Return current player credit wallet state.

Caller: Ticket Service, Admin, Reporting, Player-facing read models where authorized.

Idempotency: Not required.

High-level request fields:

- `playerId`

High-level response fields:

- `playerId`
- `creditWalletId`
- `creditLimit`
- `availableCredit`
- `usedCredit`
- `pendingExposure`
- `settledBalance`
- `carryBalance`
- `currency`
- `status`
- `correlationId`

Failure cases:

- Player not found.
- Credit wallet not found.
- Unauthorized caller.

### GET /v1/credit-wallets/{playerId}/transactions

Purpose: Return credit wallet transaction and audit history.

Caller: Admin, Reporting, Accounting, Support.

Idempotency: Not required.

High-level request fields:

- `playerId`
- `from`
- `to`
- `transactionType`
- `limit`
- `cursor`

High-level response fields:

- `transactions`
- `pagination`
- `correlationId`

Failure cases:

- Invalid filters.
- Player not found.
- Unauthorized caller.

### GET /v1/credit-wallets/{playerId}/exposure

Purpose: Return current exposure details for a player.

Caller: Ticket Service, Settlement Service, Admin, Reporting.

Idempotency: Not required.

High-level request fields:

- `playerId`
- `marketId`
- `drawId`
- `includeReservations`

High-level response fields:

- `playerId`
- `pendingExposure`
- `availableCredit`
- `reservations`
- `correlationId`

Failure cases:

- Player not found.
- Invalid filters.
- Unauthorized caller.

### GET /v1/credit-wallets/health

Purpose: Return Credit Wallet Service health and dependency status.

Caller: Load balancers, operators, monitoring.

Idempotency: Not required.

High-level request fields:

- None.

High-level response fields:

- `status`
- `service`
- `version`
- `timestamp`
- `dependencies`
- `correlationId`

Failure cases:

- Dependency unavailable.
- Service not ready.

## 11. Event Contract Candidates

### credit.limit.updated

Purpose: Notify that a player's credit limit changed.

Publisher: Credit Wallet Service.

Likely consumers: Reporting, Accounting, Admin audit, risk monitoring.

Required identifiers:

- `eventId`
- `playerId`
- `creditWalletId`
- `actorUserId`
- `correlationId`

Amount/currency fields:

- `previousLimit`
- `newLimit`

Event version: `1`.

### credit.exposure.reserved

Purpose: Notify that credit exposure was reserved for a ticket.

Publisher: Credit Wallet Service.

Likely consumers: Ticket Service, Reporting, risk monitoring, hierarchy exposure projections.

Required identifiers:

- `eventId`
- `playerId`
- `creditWalletId`
- `ticketId`
- `reservationId`
- `correlationId`

Amount/currency fields:

- `reservedAmount`
- `pendingExposure`
- `availableCredit`

Event version: `1`.

### credit.exposure.released

Purpose: Notify that pending exposure was released.

Publisher: Credit Wallet Service.

Likely consumers: Ticket Service, Settlement Service, Reporting, risk monitoring.

Required identifiers:

- `eventId`
- `playerId`
- `creditWalletId`
- `ticketId`
- `reservationId`
- `correlationId`

Amount/currency fields:

- `releasedAmount`
- `pendingExposure`
- `availableCredit`

Event version: `1`.

### credit.settlement.applied

Purpose: Notify that a settlement result was applied to credit state.

Publisher: Credit Wallet Service.

Likely consumers: Settlement Service, Accounting, Reporting, hierarchy exposure projections.

Required identifiers:

- `eventId`
- `playerId`
- `creditWalletId`
- `ticketId`
- `reservationId`
- `settlementId`
- `ledgerEntryIds`
- `correlationId`

Amount/currency fields:

- `stake`
- `payout`
- `netResult`
- `releasedExposure`
- `availableCredit`

Event version: `1`.

### credit.adjustment.posted

Purpose: Notify that a manual credit adjustment was posted.

Publisher: Credit Wallet Service.

Likely consumers: Accounting, Reporting, Admin audit, risk monitoring.

Required identifiers:

- `eventId`
- `playerId`
- `creditWalletId`
- `adjustmentId`
- `actorUserId`
- `ledgerEntryIds`
- `correlationId`

Amount/currency fields:

- `adjustmentAmount`
- `availableCredit`

Event version: `1`.

### credit.reservation.rejected

Purpose: Notify that a credit reservation was rejected.

Publisher: Credit Wallet Service.

Likely consumers: Ticket Service, risk monitoring, support tooling.

Required identifiers:

- `eventId`
- `playerId`
- `ticketId`
- `reservationId`
- `reasonCode`
- `correlationId`

Amount/currency fields:

- `requestedAmount`
- `availableCredit`
- `pendingExposure`

Event version: `1`.

## 12. Idempotency Requirements

Credit limit changes:

- Idempotency key required.
- Same key plus same payload returns the same result.
- Same key plus different payload is rejected.

Reserve:

- Idempotency key required.
- Duplicate reserve requests must not duplicate reservations.
- Reservation should also be unique by ticket/reservation identity.

Release:

- Idempotency key required.
- Duplicate release requests must not release exposure twice.
- Partial release policy must be explicit before implementation.

Settle:

- Idempotency key required.
- Duplicate settlement requests must not duplicate releases, settled impacts, or ledger entries.
- Settlement must be unique by settlement ID and ticket/reservation identity.

Adjustment:

- Idempotency key required.
- Duplicate adjustment requests must not duplicate credit changes or ledger entries.

Rule:

Duplicate requests must not duplicate reservations, releases, settlements, or adjustments.

## 13. Correlation and Audit

Correlation standard:

- `x-correlation-id` propagates through caller, Credit Wallet Service, Ledger Service, outbox, RabbitMQ, consumers, and logs.
- Caller supplies a correlation ID when available.
- Service generates one when missing.
- Responses and events include the effective correlation ID.

Audit trail expectations:

- Command ID or idempotency key.
- Actor identifiers.
- Source service.
- Player ID.
- Credit wallet ID.
- Ticket, reservation, settlement, adjustment, or ledger identifiers.
- Reason codes.
- Operational notes.
- Created timestamp.
- Before/after values where appropriate.

Audit records must be immutable or append-only. Corrections must be represented as new audit entries and compensating financial entries where required.

## 14. Reconciliation Requirements

Reconciliation targets:

- Player credit wallet balance.
- Pending exposure.
- Ledger entries.
- Ticket settlement results.
- Weekly accounting statement.
- Agent/master exposure reports.

Required reconciliation reports:

- Player credit wallet state versus credit transactions.
- Pending exposure versus unsettled tickets.
- Released exposure versus settled, voided, canceled, or refunded tickets.
- Credit settlement impacts versus settlement results.
- Credit adjustments versus ledger/audit entries.
- Weekly statement totals versus credit wallet period activity.
- Agent/master exposure aggregates versus player-level exposure.
- Event stream counts versus committed credit wallet changes.

Reconciliation must run before beta traffic, during shadow mode, during controlled cutover, after rollback, and before final ownership transfer.

## 15. Cutover Strategy

1. Planning document complete.
2. Credit Wallet contract specification created.
3. Credit Wallet Service created from `dotnet-template-service`.
4. Service initially calls existing monolith/RPC logic or wraps existing safe paths.
5. Shadow mode logging.
6. Feature flag routing.
7. Controlled beta traffic only.
8. Reconciliation validation.
9. Gradual ownership transfer.

Cutover gates:

- Contract review complete.
- Monetary standard enforced.
- Idempotency tested for all command paths.
- Concurrent reservation tests pass.
- Reconciliation reports pass.
- Rollback path tested.
- Operational dashboards and alerts exist.
- Existing monolith path remains available during Stage 1.

## 16. Rollback Strategy

Rollback requirements:

- Feature flag back to monolith.
- Existing monolith wallet paths remain intact during Stage 1.
- No data migration rollback required initially.
- Idempotent events.
- Reconciliation report after rollback.

Rollback flow:

1. Disable Credit Wallet Service routing.
2. Route commands back to the monolith wallet path.
3. Keep existing safe monolith/RPC paths intact.
4. Continue processing idempotent events.
5. Generate reconciliation report for the affected window.
6. Review reservations, releases, settlements, adjustments, and hierarchy exposure.

## 17. Risks and Mitigations

Over-crediting:

- Enforce credit limits atomically.
- Require approval workflows for limit changes.
- Reconcile limits against exposure and settlement activity.

Duplicate reservations:

- Require idempotency keys.
- Enforce uniqueness by ticket/reservation identity.
- Make reservation commands atomic.

Failed release:

- Retry idempotently.
- Alert on stale pending exposure.
- Reconcile unsettled tickets against pending exposure.

Settlement mismatch:

- Validate settlement identity and ticket/reservation relationship.
- Block mismatched settlement application.
- Require reconciliation before weekly close.

Player balance discrepancy:

- Reconcile wallet state against transactions and ledger/audit entries.
- Prevent direct state mutation outside approved service paths.

Agent exposure mismatch:

- Reconcile aggregate exposure against player-level exposure.
- Include hierarchy identifiers in reporting projections.

Race conditions:

- Lock or transactionally update credit wallet state.
- Use database constraints or service-level concurrency controls.

Concurrent ticket placement:

- Reserve exposure atomically.
- Reject reservations when available credit is insufficient at commit time.

Stale available credit:

- Treat available credit as computed from authoritative state.
- Avoid caching source-of-truth balances.
- Use short-lived read models only where consistency rules are explicit.

Service outage:

- Keep monolith fallback during Stage 1.
- Use readiness checks and feature flags.
- Define operational alerts before routing traffic.

Event ordering:

- Consumers must be idempotent.
- Events should include aggregate identifiers and versioning.
- Do not rely on global ordering across players or wallets.

## 18. Validation Checklist

- Documentation only.
- No runtime code changed.
- No database schema changed.
- No Docker changes.
- No API behavior changed.
- No service extraction performed.
- Documentation file exists at `docs/architecture/phase-11-10-credit-wallet-service-planning.md`.
- Git status shows documentation-only changes for this phase.
- `git diff --check` passes.
- No runtime code modified by this phase.
- No commit created.
- No tag created.
