# Phase 11.11 Credit Wallet Contract Specification

## 1. Purpose

The Credit Wallet Service is the future authority for player credit state and credit operations in the credit-based betting platform.

The Credit Wallet Service is responsible for:

- Credit allocation.
- Credit limits.
- Available credit.
- Pending exposure.
- Exposure reservation.
- Exposure release.
- Settlement application.
- Credit adjustments.
- Credit wallet queries.

The Credit Wallet Service is not responsible for:

- Ledger posting.
- Settlement calculations.
- Commissions.
- Weekly accounting close.
- Player identity.
- Authentication.

The service owns credit wallet contracts and state transitions, but balance-impacting financial audit entries must flow through the Ledger Service once extracted. During initial extraction, safe existing monolith/RPC paths may remain the source of execution while this contract is proven.

## 2. Locked Platform Standards

### Platform Standard #001: Monetary Representation

Rules:

- `amount` is an integer.
- Amounts are represented in minor currency units only.
- `currency` is an ISO-4217 currency code.
- Floating point monetary values are prohibited.

Canonical money DTO:

```json
{
  "amount": 1050,
  "currency": "USD"
}
```

Credit Wallet contracts must not accept or return decimal, float, or double monetary fields.

### Correlation ID Standard

Standard header:

```http
x-correlation-id
```

Rules:

- Caller supplies a correlation ID when available.
- Credit Wallet Service generates one if missing.
- The same correlation ID propagates through API, logs, audit records, outbox, RabbitMQ, consumers, Ledger Service calls, and reconciliation records.
- Responses include the effective `x-correlation-id`.

### Idempotency Standard

Standard header:

```http
Idempotency-Key
```

Rules:

- Required for all balance-impacting command endpoints.
- Same key plus same payload returns the same result.
- Same key plus different payload is rejected.
- Duplicate requests must never create duplicate financial impact.
- Idempotency records must be auditable.

## 3. Locked Credit Standards

### CREDIT STANDARD #001: Available Credit Formula

```text
availableCredit = creditLimit + balance - pendingExposure
```

Where:

- `creditLimit` is the approved player credit limit.
- `balance` is the player credit balance.
- `pendingExposure` is reserved exposure for unsettled tickets.

### CREDIT STANDARD #002: Balance Meaning

```text
balance > 0
Player is winning.

balance < 0
Player owes money.
```

`balance = 0` means the player has no settled credit gain or liability.

### CREDIT STANDARD #003: Ticket Reservation

The entire ticket amount is reserved at placement.

Partial reservation is not allowed for initial ticket acceptance. Ticket acceptance depends on successful reservation of the full ticket amount.

### CREDIT STANDARD #004: Progressive Exposure Release

Exposure is released progressively as settlement occurs.

This supports partial settlement, multi-leg settlement, void/refund scenarios, and operational recovery without requiring a single all-or-nothing exposure release.

### CREDIT STANDARD #005: Parent Credit Allocation

Credit allocation reduces parent available credit.

When a parent entity allocates credit down the hierarchy, the parent's allocatable credit is reduced by the allocation according to the selected hierarchy model.

### CREDIT STANDARD #006: Hierarchy Visibility

Visibility follows hierarchy:

- Player -> self.
- Agent -> assigned players.
- Master -> assigned agents and players.
- Super Master -> entire tree.

Access to credit state must be constrained by this hierarchy and by authentication/authorization rules owned outside the Credit Wallet Service.

## 4. Supported Hierarchy Models

### North American Model

Behavior:

- Agent controls player.
- Exposure controls are optional.
- Credit allocation may remain primarily player-centric.
- Parent-level credit may be used for reporting and risk controls without strict allocation exhaustion.
- Agent/master views focus on assigned-player exposure, weekly figures, and operational oversight.

Common characteristics:

- Player credit limit is the primary limit.
- Agent exposure may be monitored rather than strictly reserved.
- Hierarchy reporting is still mandatory.
- Commission and weekly accounting may consume exposure and settlement data.

### Asian Credit Model

Behavior:

- Credit is assigned down hierarchy.
- Parent credit is reduced by allocations.
- Exposure propagates upward.
- Available credit is constrained at each level.

Common characteristics:

- Super master allocates to masters.
- Masters allocate to agents.
- Agents allocate to players.
- Player reservations affect parent exposure and available credit.
- Parent availability must be validated before child allocation increases.

### Behavioral Differences

The North American model can allow player-centric credit controls with hierarchy visibility and optional parent exposure limits. The Asian Credit Model requires strict hierarchical allocation and exposure propagation where parent credit constrains child credit.

The contract must support both models without mixing their rules implicitly. Each wallet, tenant, market, or operator configuration should explicitly declare the active model before production use.

## 5. Core Wallet Model

Canonical wallet structure:

```json
{
  "playerId": "00000000-0000-0000-0000-000000000001",
  "creditLimit": 100000,
  "balance": -15000,
  "pendingExposure": 25000,
  "availableCredit": 60000,
  "currency": "USD"
}
```

Field definitions:

- `playerId`: player identity reference owned by the player/account domain.
- `creditLimit`: approved player credit limit in integer minor units.
- `balance`: settled credit balance. Positive means the player is winning; negative means the player owes money.
- `pendingExposure`: reserved amount for unsettled tickets.
- `availableCredit`: computed as `creditLimit + balance - pendingExposure`.
- `currency`: ISO-4217 currency code.

Recommended expanded fields:

- `creditWalletId`: stable wallet identifier.
- `status`: active, suspended, closed, or equivalent.
- `hierarchyModel`: `NORTH_AMERICAN` or `ASIAN_CREDIT`.
- `parentAccountId`: parent hierarchy reference where applicable.
- `updatedAt`: last state update timestamp.
- `version`: optimistic concurrency version where applicable.

## 6. Credit Allocation Contracts

### POST /v1/credit-wallets/{playerId}/limit

Purpose:

Set or update a player's credit limit.

Required headers:

```http
Idempotency-Key: <unique-command-key>
x-correlation-id: <trace-id>
```

Request DTO:

```json
{
  "limit": {
    "amount": 100000,
    "currency": "USD"
  },
  "reasonCode": "CREDIT_REVIEW_APPROVED",
  "actorId": "00000000-0000-0000-0000-000000000010",
  "sourceService": "admin-portal",
  "auditNotes": "Approved after weekly review.",
  "metadata": {}
}
```

Response DTO:

```json
{
  "playerId": "00000000-0000-0000-0000-000000000001",
  "creditWalletId": "00000000-0000-0000-0000-000000000002",
  "previousLimit": {
    "amount": 50000,
    "currency": "USD"
  },
  "newLimit": {
    "amount": 100000,
    "currency": "USD"
  },
  "balance": {
    "amount": -15000,
    "currency": "USD"
  },
  "pendingExposure": {
    "amount": 25000,
    "currency": "USD"
  },
  "availableCredit": {
    "amount": 60000,
    "currency": "USD"
  },
  "correlationId": "trace-id"
}
```

Validation rules:

- `Idempotency-Key` is required.
- `limit.amount` must be an integer greater than or equal to zero.
- `limit.currency` must be ISO-4217.
- `reasonCode` is required.
- `actorId` is required.
- Player must exist.
- Credit wallet must be active or eligible for limit change.

Hierarchy validation:

- In the Asian Credit Model, the parent must have sufficient allocatable credit for limit increases.
- In the North American Model, parent exposure controls are applied only when configured.
- Caller visibility must include the target player.

Failure scenarios:

- `CREDIT_VALIDATION_FAILED`
- `CREDIT_HIERARCHY_VIOLATION`
- `CREDIT_ALLOCATION_EXCEEDED`
- `CREDIT_DUPLICATE_IDEMPOTENCY_KEY`
- `CREDIT_INTERNAL_ERROR`

### POST /v1/credit-wallets/{agentId}/allocate

Purpose:

Allocate credit from an agent or parent node to a child player or subordinate node.

Request DTO:

```json
{
  "targetType": "PLAYER",
  "targetId": "00000000-0000-0000-0000-000000000001",
  "allocation": {
    "amount": 100000,
    "currency": "USD"
  },
  "reasonCode": "INITIAL_PLAYER_ALLOCATION",
  "actorId": "00000000-0000-0000-0000-000000000010",
  "sourceService": "admin-portal",
  "auditNotes": "Initial credit setup.",
  "metadata": {}
}
```

Response DTO:

```json
{
  "allocationId": "00000000-0000-0000-0000-000000000003",
  "parentId": "00000000-0000-0000-0000-000000000020",
  "targetType": "PLAYER",
  "targetId": "00000000-0000-0000-0000-000000000001",
  "allocatedCredit": {
    "amount": 100000,
    "currency": "USD"
  },
  "parentAvailableCredit": {
    "amount": 900000,
    "currency": "USD"
  },
  "correlationId": "trace-id"
}
```

Validation rules:

- `Idempotency-Key` is required.
- Allocation amount must be a non-negative integer.
- Currency must match parent allocation currency unless multi-currency rules are explicitly configured.
- Target must exist and belong under the parent hierarchy.

Hierarchy validation:

- Parent must control the target.
- Parent must have sufficient available allocation in strict hierarchy mode.
- Allocation must not violate configured model constraints.

Failure scenarios:

- `CREDIT_HIERARCHY_VIOLATION`
- `CREDIT_ALLOCATION_EXCEEDED`
- `CREDIT_VALIDATION_FAILED`
- `CREDIT_DUPLICATE_IDEMPOTENCY_KEY`
- `CREDIT_INTERNAL_ERROR`

### POST /v1/credit-wallets/{allocationId}/reallocate

Purpose:

Change an existing credit allocation.

Request DTO:

```json
{
  "newAllocation": {
    "amount": 125000,
    "currency": "USD"
  },
  "reasonCode": "PLAYER_LIMIT_REVIEW",
  "actorId": "00000000-0000-0000-0000-000000000010",
  "sourceService": "admin-portal",
  "auditNotes": "Increased allocation after review.",
  "metadata": {}
}
```

Response DTO:

```json
{
  "allocationId": "00000000-0000-0000-0000-000000000003",
  "previousAllocation": {
    "amount": 100000,
    "currency": "USD"
  },
  "newAllocation": {
    "amount": 125000,
    "currency": "USD"
  },
  "parentAvailableCredit": {
    "amount": 875000,
    "currency": "USD"
  },
  "correlationId": "trace-id"
}
```

Validation rules:

- `Idempotency-Key` is required.
- Allocation must exist.
- New amount must be a non-negative integer.
- Currency must match existing allocation.

Hierarchy validation:

- Caller must control the allocation.
- Parent must have sufficient available allocation for increases.
- Reallocation must not reduce child credit below active exposure unless explicitly allowed by policy.

Failure scenarios:

- `CREDIT_RESERVATION_NOT_FOUND` if the allocation reference is invalid and no more specific allocation error exists.
- `CREDIT_HIERARCHY_VIOLATION`
- `CREDIT_ALLOCATION_EXCEEDED`
- `CREDIT_DUPLICATE_IDEMPOTENCY_KEY`
- `CREDIT_INTERNAL_ERROR`

## 7. Exposure Reservation Contracts

### POST /v1/credit-wallets/{playerId}/reserve

Purpose:

Reserve ticket exposure.

Requirements:

- Reserve entire ticket amount.
- Must be idempotent.
- Must reject insufficient available credit.
- Must include `ticketId`.

Request DTO:

```json
{
  "ticketId": "00000000-0000-0000-0000-000000000100",
  "reservationId": "00000000-0000-0000-0000-000000000101",
  "amount": {
    "amount": 2500,
    "currency": "USD"
  },
  "marketId": "00000000-0000-0000-0000-000000000200",
  "drawId": "00000000-0000-0000-0000-000000000300",
  "sourceService": "ticket-service",
  "metadata": {}
}
```

Response DTO:

```json
{
  "reservationId": "00000000-0000-0000-0000-000000000101",
  "playerId": "00000000-0000-0000-0000-000000000001",
  "ticketId": "00000000-0000-0000-0000-000000000100",
  "reservedAmount": {
    "amount": 2500,
    "currency": "USD"
  },
  "pendingExposure": {
    "amount": 27500,
    "currency": "USD"
  },
  "availableCredit": {
    "amount": 57500,
    "currency": "USD"
  },
  "correlationId": "trace-id"
}
```

Validation rules:

- `Idempotency-Key` is required.
- `ticketId` is required.
- `reservationId` is required or generated deterministically by the service.
- Reservation amount must be greater than zero.
- Currency must match the credit wallet currency.
- Entire ticket amount must be reserved.
- Player credit wallet must be active.

Failure cases:

- `CREDIT_INSUFFICIENT_AVAILABLE`
- `CREDIT_LIMIT_EXCEEDED`
- `CREDIT_DUPLICATE_IDEMPOTENCY_KEY`
- `CREDIT_VALIDATION_FAILED`
- `CREDIT_INTERNAL_ERROR`

## 8. Exposure Release Contracts

### POST /v1/credit-wallets/{playerId}/release

Purpose:

Release previously reserved exposure.

Requirements:

- Partial release supported.
- Full release supported.
- Must be idempotent.
- Must reference reservation.

Request DTO:

```json
{
  "reservationId": "00000000-0000-0000-0000-000000000101",
  "ticketId": "00000000-0000-0000-0000-000000000100",
  "releaseAmount": {
    "amount": 2500,
    "currency": "USD"
  },
  "reasonCode": "TICKET_VOIDED",
  "sourceService": "settlement-service",
  "metadata": {}
}
```

Response DTO:

```json
{
  "reservationId": "00000000-0000-0000-0000-000000000101",
  "ticketId": "00000000-0000-0000-0000-000000000100",
  "releasedAmount": {
    "amount": 2500,
    "currency": "USD"
  },
  "remainingReservedAmount": {
    "amount": 0,
    "currency": "USD"
  },
  "pendingExposure": {
    "amount": 25000,
    "currency": "USD"
  },
  "availableCredit": {
    "amount": 60000,
    "currency": "USD"
  },
  "correlationId": "trace-id"
}
```

Validation rules:

- `Idempotency-Key` is required.
- Reservation must exist.
- Release amount must be greater than zero.
- Release amount must not exceed remaining reserved amount.
- Currency must match reservation currency.
- Release reason is required.

Failure cases:

- `CREDIT_RESERVATION_NOT_FOUND`
- `CREDIT_INVALID_RELEASE`
- `CREDIT_DUPLICATE_IDEMPOTENCY_KEY`
- `CREDIT_VALIDATION_FAILED`
- `CREDIT_INTERNAL_ERROR`

## 9. Settlement Contracts

### POST /v1/credit-wallets/{playerId}/settle

Purpose:

Apply settlement result.

Requirements:

- Release exposure.
- Apply win/loss balance impact.
- Reference ticket.
- Reference settlement batch.

Request DTO:

```json
{
  "settlementId": "00000000-0000-0000-0000-000000000400",
  "settlementBatchId": "00000000-0000-0000-0000-000000000401",
  "reservationId": "00000000-0000-0000-0000-000000000101",
  "ticketId": "00000000-0000-0000-0000-000000000100",
  "releaseAmount": {
    "amount": 2500,
    "currency": "USD"
  },
  "balanceImpact": {
    "amount": -2500,
    "currency": "USD"
  },
  "outcome": "LOSS",
  "sourceService": "settlement-service",
  "metadata": {}
}
```

Response DTO:

```json
{
  "settlementId": "00000000-0000-0000-0000-000000000400",
  "settlementBatchId": "00000000-0000-0000-0000-000000000401",
  "reservationId": "00000000-0000-0000-0000-000000000101",
  "ticketId": "00000000-0000-0000-0000-000000000100",
  "releasedExposure": {
    "amount": 2500,
    "currency": "USD"
  },
  "balanceImpact": {
    "amount": -2500,
    "currency": "USD"
  },
  "balance": {
    "amount": -17500,
    "currency": "USD"
  },
  "pendingExposure": {
    "amount": 25000,
    "currency": "USD"
  },
  "availableCredit": {
    "amount": 57500,
    "currency": "USD"
  },
  "ledgerEntryIds": [
    "00000000-0000-0000-0000-000000000500"
  ],
  "correlationId": "trace-id"
}
```

Validation rules:

- `Idempotency-Key` is required.
- Settlement ID is required.
- Settlement batch ID is required.
- Ticket ID is required.
- Reservation reference is required unless settlement policy explicitly supports no-reservation settlement.
- Release amount must not exceed remaining reserved exposure.
- Balance impact must use integer minor units.
- Currency must match wallet and reservation currency.

Failure cases:

- `CREDIT_INVALID_SETTLEMENT`
- `CREDIT_RESERVATION_NOT_FOUND`
- `CREDIT_DUPLICATE_IDEMPOTENCY_KEY`
- `CREDIT_VALIDATION_FAILED`
- `CREDIT_INTERNAL_ERROR`

## 10. Adjustment Contracts

### POST /v1/credit-wallets/{playerId}/adjust

Requirements:

- `reasonCode` is mandatory.
- `actorId` is mandatory.
- `correlationId` is mandatory or generated by the service.
- Audit trail is mandatory.
- Ledger linkage is mandatory for balance-impacting adjustments.

Request DTO:

```json
{
  "adjustmentType": "MANUAL_CREDIT",
  "amount": {
    "amount": 10000,
    "currency": "USD"
  },
  "reasonCode": "MANUAL_CORRECTION",
  "actorId": "00000000-0000-0000-0000-000000000010",
  "sourceService": "admin-portal",
  "auditNotes": "Correction approved by operations.",
  "reference": {
    "type": "support_case",
    "id": "CASE-12345"
  },
  "metadata": {}
}
```

Response DTO:

```json
{
  "adjustmentId": "00000000-0000-0000-0000-000000000600",
  "playerId": "00000000-0000-0000-0000-000000000001",
  "adjustmentType": "MANUAL_CREDIT",
  "amount": {
    "amount": 10000,
    "currency": "USD"
  },
  "balance": {
    "amount": -7500,
    "currency": "USD"
  },
  "availableCredit": {
    "amount": 67500,
    "currency": "USD"
  },
  "ledgerEntryIds": [
    "00000000-0000-0000-0000-000000000501"
  ],
  "correlationId": "trace-id"
}
```

Validation rules:

- `Idempotency-Key` is required.
- Adjustment type is required.
- Amount must be non-zero integer minor units.
- Currency must match wallet currency.
- `reasonCode` is required.
- `actorId` is required.
- Audit notes are required for manual operations.
- Ledger linkage is required for balance-impacting changes.

Failure cases:

- `CREDIT_INVALID_ADJUSTMENT`
- `CREDIT_DUPLICATE_IDEMPOTENCY_KEY`
- `CREDIT_VALIDATION_FAILED`
- `CREDIT_INTERNAL_ERROR`

## 11. Query Contracts

### GET /v1/credit-wallets/{playerId}

Request parameters:

- `playerId`: required path UUID.

Response DTO:

```json
{
  "playerId": "00000000-0000-0000-0000-000000000001",
  "creditWalletId": "00000000-0000-0000-0000-000000000002",
  "creditLimit": {
    "amount": 100000,
    "currency": "USD"
  },
  "balance": {
    "amount": -15000,
    "currency": "USD"
  },
  "pendingExposure": {
    "amount": 25000,
    "currency": "USD"
  },
  "availableCredit": {
    "amount": 60000,
    "currency": "USD"
  },
  "status": "ACTIVE",
  "hierarchyModel": "ASIAN_CREDIT",
  "correlationId": "trace-id"
}
```

### GET /v1/credit-wallets/{playerId}/transactions

Request parameters:

- `playerId`: required path UUID.
- `from`: optional ISO-8601 timestamp.
- `to`: optional ISO-8601 timestamp.
- `transactionType`: optional filter.
- `limit`: optional integer, default `50`, maximum `250`.
- `cursor`: optional opaque cursor.
- `sort`: optional, `createdAt.asc` or `createdAt.desc`, default `createdAt.desc`.

Response DTO:

```json
{
  "transactions": [
    {
      "transactionId": "00000000-0000-0000-0000-000000000700",
      "type": "RESERVATION",
      "amount": {
        "amount": 2500,
        "currency": "USD"
      },
      "ticketId": "00000000-0000-0000-0000-000000000100",
      "ledgerEntryIds": [],
      "createdAt": "2026-06-17T00:00:00.000Z"
    }
  ],
  "pagination": {
    "limit": 50,
    "nextCursor": null
  },
  "correlationId": "trace-id"
}
```

### GET /v1/credit-wallets/{playerId}/exposure

Request parameters:

- `playerId`: required path UUID.
- `marketId`: optional UUID.
- `drawId`: optional UUID.
- `includeReservations`: optional boolean, default `false`.

Response DTO:

```json
{
  "playerId": "00000000-0000-0000-0000-000000000001",
  "pendingExposure": {
    "amount": 25000,
    "currency": "USD"
  },
  "availableCredit": {
    "amount": 60000,
    "currency": "USD"
  },
  "reservations": [],
  "correlationId": "trace-id"
}
```

### GET /v1/credit-wallets/{playerId}/summary

Request parameters:

- `playerId`: required path UUID.
- `periodId`: optional accounting period UUID.
- `from`: optional ISO-8601 timestamp.
- `to`: optional ISO-8601 timestamp.

Response DTO:

```json
{
  "playerId": "00000000-0000-0000-0000-000000000001",
  "openingBalance": {
    "amount": 0,
    "currency": "USD"
  },
  "closingBalance": {
    "amount": -15000,
    "currency": "USD"
  },
  "totalReserved": {
    "amount": 25000,
    "currency": "USD"
  },
  "totalReleased": {
    "amount": 12500,
    "currency": "USD"
  },
  "totalSettledImpact": {
    "amount": -15000,
    "currency": "USD"
  },
  "correlationId": "trace-id"
}
```

### GET /v1/credit-wallets/health

Response DTO:

```json
{
  "status": "ok",
  "service": "credit-wallet-service",
  "version": "1.0.0",
  "timestamp": "2026-06-17T00:00:00.000Z",
  "dependencies": {
    "database": "ready",
    "ledgerService": "ready",
    "rabbitmq": "ready"
  },
  "correlationId": "trace-id"
}
```

Pagination rules:

- Cursor pagination is preferred.
- Cursors are opaque to clients.
- Default page size is `50`.
- Maximum page size is `250`.

Filtering rules:

- Filters must be explicit query parameters.
- Unknown filters should return validation errors.
- Time range filters use ISO-8601 timestamps.

Sort order:

- Default sort order is newest first.
- Supported sort values are endpoint-specific and must be documented.

## 12. Event Contracts

All events use this envelope:

```json
{
  "eventId": "00000000-0000-0000-0000-000000000900",
  "eventType": "credit.exposure.reserved",
  "eventVersion": 1,
  "correlationId": "trace-id",
  "timestamp": "2026-06-17T00:00:00.000Z",
  "actorId": "00000000-0000-0000-0000-000000000010",
  "sourceService": "credit-wallet-service",
  "payload": {}
}
```

### credit.limit.updated

Payload:

```json
{
  "playerId": "uuid",
  "creditWalletId": "uuid",
  "previousLimit": {
    "amount": 50000,
    "currency": "USD"
  },
  "newLimit": {
    "amount": 100000,
    "currency": "USD"
  },
  "reasonCode": "CREDIT_REVIEW_APPROVED"
}
```

### credit.allocation.created

Payload:

```json
{
  "allocationId": "uuid",
  "parentId": "uuid",
  "targetType": "PLAYER",
  "targetId": "uuid",
  "allocatedCredit": {
    "amount": 100000,
    "currency": "USD"
  }
}
```

### credit.allocation.updated

Payload:

```json
{
  "allocationId": "uuid",
  "parentId": "uuid",
  "targetType": "PLAYER",
  "targetId": "uuid",
  "previousAllocation": {
    "amount": 100000,
    "currency": "USD"
  },
  "newAllocation": {
    "amount": 125000,
    "currency": "USD"
  }
}
```

### credit.exposure.reserved

Payload:

```json
{
  "playerId": "uuid",
  "creditWalletId": "uuid",
  "ticketId": "uuid",
  "reservationId": "uuid",
  "reservedAmount": {
    "amount": 2500,
    "currency": "USD"
  },
  "pendingExposure": {
    "amount": 27500,
    "currency": "USD"
  },
  "availableCredit": {
    "amount": 57500,
    "currency": "USD"
  }
}
```

### credit.exposure.released

Payload:

```json
{
  "playerId": "uuid",
  "creditWalletId": "uuid",
  "ticketId": "uuid",
  "reservationId": "uuid",
  "releasedAmount": {
    "amount": 2500,
    "currency": "USD"
  },
  "remainingReservedAmount": {
    "amount": 0,
    "currency": "USD"
  },
  "pendingExposure": {
    "amount": 25000,
    "currency": "USD"
  },
  "availableCredit": {
    "amount": 60000,
    "currency": "USD"
  }
}
```

### credit.settlement.applied

Payload:

```json
{
  "playerId": "uuid",
  "creditWalletId": "uuid",
  "ticketId": "uuid",
  "reservationId": "uuid",
  "settlementId": "uuid",
  "settlementBatchId": "uuid",
  "releasedExposure": {
    "amount": 2500,
    "currency": "USD"
  },
  "balanceImpact": {
    "amount": -2500,
    "currency": "USD"
  },
  "balance": {
    "amount": -17500,
    "currency": "USD"
  },
  "ledgerEntryIds": [
    "uuid"
  ]
}
```

### credit.adjustment.posted

Payload:

```json
{
  "playerId": "uuid",
  "creditWalletId": "uuid",
  "adjustmentId": "uuid",
  "adjustmentType": "MANUAL_CREDIT",
  "amount": {
    "amount": 10000,
    "currency": "USD"
  },
  "reasonCode": "MANUAL_CORRECTION",
  "ledgerEntryIds": [
    "uuid"
  ]
}
```

### credit.reservation.rejected

Payload:

```json
{
  "playerId": "uuid",
  "creditWalletId": "uuid",
  "ticketId": "uuid",
  "reservationId": "uuid",
  "requestedAmount": {
    "amount": 2500,
    "currency": "USD"
  },
  "availableCredit": {
    "amount": 1000,
    "currency": "USD"
  },
  "reasonCode": "CREDIT_INSUFFICIENT_AVAILABLE"
}
```

Event rules:

- Events are immutable.
- Events are append-only.
- Corrections are new events.
- Consumers must be idempotent.
- Event versions are independent from API versions.

## 13. Error Model

Standard error response:

```json
{
  "error": {
    "code": "CREDIT_INSUFFICIENT_AVAILABLE",
    "message": "Available credit is insufficient for the requested reservation.",
    "details": {
      "field": "amount"
    }
  },
  "correlationId": "trace-id"
}
```

Standard error codes:

- `CREDIT_LIMIT_EXCEEDED`
- `CREDIT_INSUFFICIENT_AVAILABLE`
- `CREDIT_RESERVATION_NOT_FOUND`
- `CREDIT_INVALID_RELEASE`
- `CREDIT_INVALID_SETTLEMENT`
- `CREDIT_INVALID_ADJUSTMENT`
- `CREDIT_HIERARCHY_VIOLATION`
- `CREDIT_ALLOCATION_EXCEEDED`
- `CREDIT_DUPLICATE_IDEMPOTENCY_KEY`
- `CREDIT_VALIDATION_FAILED`
- `CREDIT_INTERNAL_ERROR`

Error responses must include correlation ID and must not expose secrets, stack traces, raw SQL errors, or internal infrastructure details.

## 14. Idempotency Requirements

Allocation:

- Required.
- Duplicate allocation commands must return the original allocation result.
- Same key with a different payload must be rejected.

Reallocation:

- Required.
- Duplicate reallocation commands must return the original reallocation result.
- Parent allocation must not be reduced or increased twice by duplicate retries.

Reserve:

- Required.
- Duplicate reserve commands must not duplicate reservations or pending exposure.
- Reservation identity should be unique by ticket/reservation.

Release:

- Required.
- Duplicate release commands must not release the same exposure twice.
- Partial release commands must have stable release identifiers.

Settle:

- Required.
- Duplicate settlement commands must not duplicate balance impact, exposure release, or ledger linkage.
- Settlement identity should be unique by settlement and ticket.

Adjust:

- Required.
- Duplicate adjustment commands must not duplicate credit impact or ledger entries.

Rule:

Duplicate requests must never create duplicate financial impact.

## 15. Correlation and Audit Requirements

Every balance-impacting operation must be traceable.

Required audit fields:

- `x-correlation-id`.
- `actorId`.
- `sourceService`.
- `reasonCode`.
- Audit notes.
- Idempotency key.
- Player ID.
- Credit wallet ID.
- Ticket, reservation, settlement, allocation, adjustment, or ledger identifiers as applicable.
- Request hash or equivalent payload fingerprint.
- Created timestamp.

Audit requirements:

- Audit records must be immutable or append-only.
- Manual operations require actor and reason.
- Automated service operations require source service and correlation ID.
- Ledger linkage is required for balance-impacting credit changes.
- Operational notes must be retained for support and compliance workflows.

## 16. Reconciliation Requirements

Player reconciliation targets:

- `balance`.
- `pendingExposure`.
- `availableCredit`.

Hierarchy reconciliation targets:

- Agent exposure.
- Master exposure.
- Super master exposure.

Cross-check targets:

- Credit Wallet.
- Ledger.
- Tickets.
- Settlement.
- Accounting.

Required reports:

- Player wallet state versus credit transaction history.
- Pending exposure versus unsettled ticket reservations.
- Settlement impact versus ticket settlement results.
- Released exposure versus reservation lifecycle.
- Credit adjustments versus ledger entries and audit records.
- Agent exposure aggregate versus assigned player exposure.
- Master exposure aggregate versus assigned agent/player exposure.
- Super master exposure aggregate versus full tree exposure.
- Weekly accounting statement versus credit wallet period activity.
- Event stream counts versus committed credit wallet changes.

Reconciliation must run before cutover, during shadow mode, during beta rollout, after rollback, and before ownership transfer.

## 17. Cutover Strategy

1. Contract approval.
2. Credit Wallet Service creation.
3. Shadow mode validation.
4. Feature flag routing.
5. Controlled beta rollout.
6. Reconciliation validation.
7. Ownership transfer.

Cutover gates:

- Contract tests exist for all command and query endpoints.
- Idempotency tests pass for all balance-impacting operations.
- Concurrent reservation tests pass.
- Hierarchy allocation tests pass for both supported hierarchy models.
- Reconciliation reports pass.
- Monolith fallback is tested.
- Operational dashboards and alerts exist.

## 18. Rollback Strategy

Rollback requirements:

- Feature flag rollback.
- Monolith path remains available.
- No data migration rollback required initially.
- Idempotent event handling.
- Reconciliation report after rollback.

Rollback flow:

1. Disable Credit Wallet Service routing.
2. Route commands back to the monolith path.
3. Keep existing monolith wallet paths intact.
4. Continue idempotent event processing.
5. Generate reconciliation report for the rollback window.
6. Investigate allocation, reservation, release, settlement, adjustment, and hierarchy discrepancies.

## 19. Risks and Mitigations

Over-allocation:

- Enforce parent allocation constraints atomically.
- Reconcile parent available credit against child allocations.

Duplicate reservation:

- Require idempotency and reservation uniqueness.
- Make reservation updates atomic.

Duplicate settlement:

- Require idempotency and settlement uniqueness.
- Ensure settlement cannot apply balance impact twice.

Exposure mismatch:

- Reconcile pending exposure against active reservations and unsettled tickets.
- Alert on stale exposure.

Hierarchy mismatch:

- Reconcile hierarchy aggregates against player-level state.
- Validate ownership before allocation, reservation visibility, and query access.

Race conditions:

- Use transactional locking or optimistic concurrency.
- Validate available credit at commit time.

Stale credit availability:

- Compute availability from authoritative state.
- Avoid caching source-of-truth financial values.

Service outage:

- Keep feature-flag fallback during early stages.
- Use readiness checks and operational alerts.

Event ordering:

- Make consumers idempotent.
- Avoid global ordering assumptions.
- Include aggregate identifiers and timestamps.

Reconciliation drift:

- Run scheduled reconciliation.
- Block ownership transfer until drift is understood and resolved.

## 20. Validation Checklist

- Documentation only.
- No runtime code changed.
- No schema changed.
- No service extraction performed.
- No Docker changes.
- No API behavior changes.
- Documentation file exists at `docs/architecture/phase-11-11-credit-wallet-contract-specification.md`.
- Git status shows documentation-only changes for this phase.
- `git diff --check` passes.
- No runtime code modified by this phase.
- No commit created.
- No tag created.

## Unresolved Contract Questions

- Which hierarchy model is default for launch: North American, Asian Credit, or operator-configured per market?
- Should allocation endpoints target only players initially, or support agent/master allocations in the first implementation?
- Should `reservationId` be caller supplied, service generated, or both?
- How should partial release identifiers be modeled for progressive settlement?
- Which credit balance impacts require Ledger Service entries during the first extraction stage?
- How will weekly zero-balance reset interact with carry balance and hierarchy exposure?
- Should free play credit live inside Credit Wallet Service or remain a separate promotional wallet/service?
