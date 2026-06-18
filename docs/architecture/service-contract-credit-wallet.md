# Credit Wallet Service Contract

## Purpose

This contract defines the internal Credit Wallet boundary that will later map to an extracted Credit Wallet Service. Production traffic remains in the monolith in Phase 13.1.

## Ownership

Credit Wallet owns:

- Credit exposure reservation.
- Exposure release.
- Settlement-linked credit application.
- Player credit summary.
- Reservation cancellation.

Credit Wallet does not own ticket grading, settlement result calculation, ledger posting rules, cashier lifecycle, commission calculation, weekly accounting close, or authentication.

## Commands

### Reserve Exposure

Internal entry point: `reserveCreditExposure`

Input:

- `playerId`
- `ticketId`
- `amount`
- `currency`
- `idempotencyKey`
- optional `correlationId`
- optional `metadata`

Output:

- Credit reservation.

Requirements:

- Amount uses integer minor units.
- Currency is ISO-4217.
- Entire ticket exposure is reserved at placement.
- Duplicate idempotency keys must not double-reserve.

Events:

- `credit.reservation.created` when produced by the existing outbox path.

External endpoint mapping:

- `POST /v1/credit/reservations`

### Release Exposure

Internal entry point: `releaseCreditExposure`

Input:

- `reservationId`
- `ticketId`
- `releaseAmount`
- `idempotencyKey`
- optional `correlationId`
- optional `reason`
- optional `metadata`

Output:

- Updated reservation.

Requirements:

- Release amount is a positive integer minor-unit value.
- Remaining exposure must never become negative.
- Duplicate idempotency keys must not double-release.

Events:

- `credit.reservation.released` when produced by the existing outbox path.

External endpoint mapping:

- `POST /v1/credit/reservations/{reservationId}/release`

### Apply Credit Settlement

Internal entry point: `applyCreditSettlement`

Input:

- `reservationId`
- `ticketId`
- `settlementId`
- `releaseAmount`
- `balanceImpact`
- `currency`
- `idempotencyKey`
- optional `correlationId`
- optional `metadata`

Output:

- Credit settlement application result.

Requirements:

- Release and balance impact are integer minor-unit values.
- Balance impact may be positive, zero, or negative.
- Settlement applications are auditable and idempotent.

Events:

- `credit.settlement.applied`
- `credit.balance.updated`

External endpoint mapping:

- `POST /v1/credit/settlements/apply`

### Get Credit Summary

Internal entry point: `getPlayerCreditSummary`

Input:

- `playerId`

Output:

- `creditLimit + balance - pendingExposure = availableCredit`

External endpoint mapping:

- `GET /v1/credit/players/{playerId}/summary`

### Cancel Reservation

Internal entry point: `cancelCreditReservation`

Input:

- `reservationId`
- optional `correlationId`
- optional `reason`

Output:

- Cancelled reservation.

Requirements:

- Cancellation must be traceable.
- Financial source-of-truth data remains in Postgres.

External endpoint mapping:

- `POST /v1/credit/reservations/{reservationId}/cancel`

## Extraction Notes

The extracted Credit Wallet Service must not cache or own financial source-of-truth balances in Redis. Database state remains authoritative until a later data ownership migration is proven.
