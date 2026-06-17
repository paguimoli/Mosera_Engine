# Phase 11.8 Ledger Contract Specification

## 1. Purpose

The Ledger Service is the future service boundary responsible for financial ledger posting, reversal, query, audit, and event contracts.

Ledger is the system of record for financial entries. Ledger records are append-only. Ledger entries are immutable after creation. Corrections are performed through reversal entries and new entries, never through edits or deletes of existing ledger entries.

The Ledger Service owns posting and reversal authority. In the initial extraction stage, this authority is implemented by wrapping the existing hardened database RPCs. The service must not independently calculate wallet balances during that stage.

## 2. Service Ownership

The Ledger Service owns:

- Financial ledger posting interface.
- Financial ledger reversal interface.
- Ledger entry query interface.
- Ledger audit trail.
- Ledger event publication.

The Ledger Service does not own:

- Wallet business policy.
- Cashier approval workflow.
- Settlement decisions.
- Player lifecycle.
- Commission calculations.
- Weekly accounting close.
- Authentication.
- Market configuration.

Callers remain responsible for their domain decisions before requesting a ledger posting. The Ledger Service is responsible for recording approved financial movement through immutable ledger entries.

## 3. Platform Monetary Standard (LOCKED)

This monetary standard applies to all services.

Rules:

- All monetary amounts are represented as integer minor currency units.
- Floating point monetary values are prohibited.
- Currency must be ISO-4217.

Canonical format:

```json
{
  "amount": 1050,
  "currency": "USD"
}
```

Examples:

```json
{
  "amount": 5000,
  "currency": "CRC"
}
```

```json
{
  "amount": 1299,
  "currency": "EUR"
}
```

Additional rules:

- Ledger stores integer amounts only.
- Wallet stores integer amounts only.
- Cashier stores integer amounts only.
- Settlement stores integer amounts only.
- Commission stores integer amounts only.
- Accounting stores integer amounts only.

Formatting is the responsibility of:

- UI.
- Reports.
- Exports.
- External integrations.

Ledger must never accept or return floating point values. Decimal display rules, currency symbols, thousands separators, and localized formatting are presentation concerns.

## 4. Correlation ID Standard

Standard header:

```http
x-correlation-id
```

Rules:

- Caller supplies a correlation ID when available.
- Ledger generates a correlation ID if missing.
- The same correlation ID propagates through API, outbox, RabbitMQ, consumers, and logs.
- Responses include the effective `x-correlation-id`.
- Events include the effective correlation ID.
- Errors include the effective correlation ID.

Correlation IDs are operational trace identifiers. They are not idempotency keys and must not be used as financial uniqueness constraints.

## 5. Idempotency Standard

Standard header:

```http
Idempotency-Key
```

Rules:

- Required for posting operations.
- Required for reversal operations.
- Same key plus same payload returns the same result.
- Duplicate submissions must not create duplicate ledger entries.
- Idempotency records must be auditable.
- Same key with a meaningfully different payload must be rejected.

Idempotency applies to command endpoints only. Query endpoints do not require `Idempotency-Key`.

The idempotency scope should include:

- API version.
- Endpoint.
- Caller or service identity where available.
- Idempotency key.
- Request payload hash.

## 6. API Versioning Strategy

Ledger APIs use path-based versioning:

```text
/v1/ledger/...
```

Rules:

- Breaking changes require a new API version.
- Backward compatibility is preferred for non-breaking additions.
- Event versions are independent of API versions.
- New optional response fields may be added within a version.
- Existing field meaning, type, and requiredness must not change within a version.
- Deprecated fields must remain documented until the version is retired.

## 7. Ledger Command Contracts

### POST /v1/ledger/entries

Creates a new immutable ledger entry through the approved financial posting path.

Required headers:

```http
Idempotency-Key: <unique-command-key>
x-correlation-id: <trace-id>
```

`x-correlation-id` is optional for callers but always present in the response.

Request schema:

```json
{
  "walletId": "uuid",
  "transactionType": "DEPOSIT",
  "direction": "CREDIT",
  "money": {
    "amount": 1050,
    "currency": "USD"
  },
  "reference": {
    "type": "cashier_transaction",
    "id": "uuid-or-external-id"
  },
  "metadata": {
    "source": "cashier"
  }
}
```

Request fields:

- `walletId`: required UUID. Identifies the wallet affected by the entry.
- `transactionType`: required string. Must be one of the approved ledger transaction types.
- `direction`: required string. Allowed values are `CREDIT` and `DEBIT`.
- `money.amount`: required integer. Must be greater than zero.
- `money.currency`: required ISO-4217 string.
- `reference.type`: optional string. Identifies the source domain or object type.
- `reference.id`: optional string. Identifies the source object.
- `metadata`: optional object. Audit metadata only; must not be required to compute balances.

Approved `transactionType` values:

- `DEPOSIT`
- `WITHDRAWAL`
- `TICKET_STAKE`
- `TICKET_WIN`
- `TICKET_REFUND`
- `TICKET_VOID`
- `FREE_PLAY_CREDIT`
- `FREE_PLAY_STAKE`
- `FREE_PLAY_WIN`
- `MANUAL_CREDIT_ADJUSTMENT`
- `MANUAL_DEBIT_ADJUSTMENT`
- `SETTLEMENT_CREDIT`
- `SETTLEMENT_DEBIT`
- `ZERO_BALANCE_CREDIT`
- `ZERO_BALANCE_DEBIT`
- `REVERSAL`

Response schema:

```json
{
  "ledgerEntry": {
    "id": "uuid",
    "walletId": "uuid",
    "accountId": "uuid",
    "transactionType": "DEPOSIT",
    "direction": "CREDIT",
    "money": {
      "amount": 1050,
      "currency": "USD"
    },
    "balanceAfter": {
      "amount": 12050,
      "currency": "USD"
    },
    "reference": {
      "type": "cashier_transaction",
      "id": "uuid-or-external-id"
    },
    "idempotencyKey": "string",
    "reversalOfLedgerEntryId": null,
    "metadata": {
      "source": "cashier"
    },
    "createdAt": "2026-06-17T00:00:00.000Z"
  },
  "correlationId": "string"
}
```

Validation rules:

- `Idempotency-Key` is required.
- `walletId` must be a valid UUID.
- `transactionType` must be approved.
- `direction` must be `CREDIT` or `DEBIT`.
- `money.amount` must be an integer greater than zero.
- `money.currency` must be ISO-4217.
- Floating point values are rejected.
- Caller must not provide `balanceAfter`.
- Caller must not provide ledger entry creation timestamps.

Success responses:

- `201 Created`: ledger entry was created.
- `200 OK`: idempotent retry returned the existing ledger entry.

Failure responses:

- `400 Bad Request`: validation failed.
- `404 Not Found`: wallet or ledger account not found.
- `409 Conflict`: idempotency key was reused with a different payload.
- `422 Unprocessable Entity`: posting is rejected by ledger constraints.
- `500 Internal Server Error`: unexpected service failure.

Idempotency behavior:

- First successful command creates a ledger entry.
- Retrying the same command with the same idempotency key and same payload returns the same ledger entry.
- Retrying with the same key and a different payload returns `LEDGER_DUPLICATE_IDEMPOTENCY_KEY`.
- Handler retries must be safe.

Correlation behavior:

- The service accepts `x-correlation-id` when provided.
- The service generates one when missing.
- The response includes the effective correlation ID.
- Ledger events and logs include the same correlation ID.

### POST /v1/ledger/entries/{ledgerEntryId}/reverse

Creates an immutable reversal entry for an existing ledger entry.

Required headers:

```http
Idempotency-Key: <unique-reversal-key>
x-correlation-id: <trace-id>
```

Request schema:

```json
{
  "reason": "cashier correction approved by operations",
  "actorUserId": "uuid",
  "metadata": {
    "caseId": "OPS-12345"
  }
}
```

Request fields:

- `reason`: required string. Human-readable reason for reversal.
- `actorUserId`: optional UUID. User or operator initiating the reversal.
- `metadata`: optional object. Audit metadata only.

Response schema:

```json
{
  "ledgerEntry": {
    "id": "uuid",
    "walletId": "uuid",
    "accountId": "uuid",
    "transactionType": "REVERSAL",
    "direction": "DEBIT",
    "money": {
      "amount": 1050,
      "currency": "USD"
    },
    "balanceAfter": {
      "amount": 11000,
      "currency": "USD"
    },
    "reference": {
      "type": "ledger_entry",
      "id": "original-ledger-entry-id"
    },
    "idempotencyKey": "string",
    "reversalOfLedgerEntryId": "original-ledger-entry-id",
    "metadata": {
      "reason": "cashier correction approved by operations",
      "actorUserId": "uuid",
      "caseId": "OPS-12345"
    },
    "createdAt": "2026-06-17T00:00:00.000Z"
  },
  "correlationId": "string"
}
```

Validation rules:

- `ledgerEntryId` must be a valid UUID.
- `Idempotency-Key` is required.
- `reason` is required.
- Original ledger entry must exist.
- Original ledger entry must be eligible for reversal.
- A ledger entry must not be reversed more than once unless a future approved policy explicitly permits it.
- Reversal amount must match the original ledger entry amount.
- Reversal currency must match the original ledger entry currency.
- Reversal direction must be the opposite of the original direction.

Reversal rules:

- Original `CREDIT` reverses with `DEBIT`.
- Original `DEBIT` reverses with `CREDIT`.
- Reversal `transactionType` is `REVERSAL`.
- Reversal `reference.type` is `ledger_entry`.
- Reversal `reference.id` is the original ledger entry ID.
- Reversal `reversalOfLedgerEntryId` is the original ledger entry ID.
- Original ledger entry is never updated or deleted.

Audit requirements:

- Reversal reason is recorded.
- Actor user ID is recorded when available.
- Correlation ID is recorded.
- Idempotency key is recorded.
- Reversal event is emitted or recorded after successful commit.

Success responses:

- `201 Created`: reversal entry was created.
- `200 OK`: idempotent retry returned the existing reversal entry.

Failure responses:

- `400 Bad Request`: validation failed.
- `404 Not Found`: original ledger entry not found.
- `409 Conflict`: idempotency key conflict.
- `422 Unprocessable Entity`: reversal is not allowed.
- `500 Internal Server Error`: unexpected service failure.

## 8. Ledger Query Contracts

### GET /v1/ledger/entries/{ledgerEntryId}

Returns a single ledger entry by ID.

Request parameters:

- `ledgerEntryId`: required UUID path parameter.

Response schema:

```json
{
  "ledgerEntry": {
    "id": "uuid",
    "walletId": "uuid",
    "accountId": "uuid",
    "transactionType": "DEPOSIT",
    "direction": "CREDIT",
    "money": {
      "amount": 1050,
      "currency": "USD"
    },
    "balanceAfter": {
      "amount": 12050,
      "currency": "USD"
    },
    "reference": {
      "type": "cashier_transaction",
      "id": "uuid-or-external-id"
    },
    "idempotencyKey": "string",
    "reversalOfLedgerEntryId": null,
    "metadata": {},
    "createdAt": "2026-06-17T00:00:00.000Z"
  },
  "correlationId": "string"
}
```

Failure responses:

- `400 Bad Request`: invalid ledger entry ID.
- `404 Not Found`: ledger entry not found.
- `500 Internal Server Error`: unexpected service failure.

### GET /v1/ledger/accounts/{accountId}/entries

Returns ledger entries for an account.

Request parameters:

- `accountId`: required UUID path parameter.
- `walletId`: optional UUID query filter.
- `transactionType`: optional query filter.
- `direction`: optional query filter, `CREDIT` or `DEBIT`.
- `referenceType`: optional query filter.
- `referenceId`: optional query filter.
- `createdFrom`: optional ISO-8601 timestamp.
- `createdTo`: optional ISO-8601 timestamp.
- `limit`: optional integer, default `50`, maximum `250`.
- `cursor`: optional opaque pagination cursor.
- `sort`: optional string, allowed values `createdAt.asc` and `createdAt.desc`, default `createdAt.desc`.

Response schema:

```json
{
  "entries": [
    {
      "id": "uuid",
      "walletId": "uuid",
      "accountId": "uuid",
      "transactionType": "DEPOSIT",
      "direction": "CREDIT",
      "money": {
        "amount": 1050,
        "currency": "USD"
      },
      "balanceAfter": {
        "amount": 12050,
        "currency": "USD"
      },
      "reference": {
        "type": "cashier_transaction",
        "id": "uuid-or-external-id"
      },
      "idempotencyKey": "string",
      "reversalOfLedgerEntryId": null,
      "metadata": {},
      "createdAt": "2026-06-17T00:00:00.000Z"
    }
  ],
  "pagination": {
    "limit": 50,
    "nextCursor": "opaque-cursor-or-null"
  },
  "correlationId": "string"
}
```

Pagination rules:

- Results are cursor paginated.
- Default sort order is newest first.
- Cursor values are opaque to clients.
- Cursor pagination must be stable when multiple entries share the same timestamp.

Failure responses:

- `400 Bad Request`: invalid filters or pagination.
- `404 Not Found`: account not found, if account existence is checked by Ledger Service.
- `500 Internal Server Error`: unexpected service failure.

### GET /v1/ledger/health

Returns Ledger Service health.

Response schema:

```json
{
  "status": "ok",
  "service": "ledger-service",
  "version": "1.0.0",
  "timestamp": "2026-06-17T00:00:00.000Z",
  "dependencies": {
    "database": "ready",
    "rabbitmq": "ready"
  },
  "correlationId": "string"
}
```

The health endpoint must not expose secrets, connection strings, credentials, or sensitive operational internals.

## 9. Error Model

Standard error response:

```json
{
  "error": {
    "code": "LEDGER_INVALID_AMOUNT",
    "message": "Ledger amount must be a positive integer minor currency value.",
    "details": {
      "field": "money.amount"
    }
  },
  "correlationId": "string"
}
```

Standard error codes:

- `LEDGER_ACCOUNT_NOT_FOUND`
- `LEDGER_ENTRY_NOT_FOUND`
- `LEDGER_INVALID_AMOUNT`
- `LEDGER_DUPLICATE_IDEMPOTENCY_KEY`
- `LEDGER_REVERSAL_NOT_ALLOWED`
- `LEDGER_UNSUPPORTED_CURRENCY`
- `LEDGER_VALIDATION_FAILED`
- `LEDGER_INTERNAL_ERROR`

Error mapping:

- `LEDGER_ACCOUNT_NOT_FOUND`: HTTP `404`.
- `LEDGER_ENTRY_NOT_FOUND`: HTTP `404`.
- `LEDGER_INVALID_AMOUNT`: HTTP `400`.
- `LEDGER_DUPLICATE_IDEMPOTENCY_KEY`: HTTP `409`.
- `LEDGER_REVERSAL_NOT_ALLOWED`: HTTP `422`.
- `LEDGER_UNSUPPORTED_CURRENCY`: HTTP `400`.
- `LEDGER_VALIDATION_FAILED`: HTTP `400`.
- `LEDGER_INTERNAL_ERROR`: HTTP `500`.

Error responses must include correlation ID and must not expose database stack traces, credentials, or internal SQL details.

## 10. Event Contracts

Ledger events are immutable. Ledger events are append-only. Ledger events are never updated. Corrections are represented as new events.

All events include this envelope:

```json
{
  "eventId": "uuid",
  "eventType": "ledger.entry.posted",
  "eventVersion": 1,
  "correlationId": "string",
  "timestamp": "2026-06-17T00:00:00.000Z",
  "payload": {}
}
```

### ledger.entry.posted

```json
{
  "eventId": "uuid",
  "eventType": "ledger.entry.posted",
  "eventVersion": 1,
  "correlationId": "string",
  "timestamp": "2026-06-17T00:00:00.000Z",
  "payload": {
    "ledgerEntryId": "uuid",
    "walletId": "uuid",
    "accountId": "uuid",
    "transactionType": "DEPOSIT",
    "direction": "CREDIT",
    "money": {
      "amount": 1050,
      "currency": "USD"
    },
    "balanceAfter": {
      "amount": 12050,
      "currency": "USD"
    },
    "reference": {
      "type": "cashier_transaction",
      "id": "uuid-or-external-id"
    },
    "idempotencyKey": "string",
    "createdAt": "2026-06-17T00:00:00.000Z"
  }
}
```

### ledger.entry.reversed

```json
{
  "eventId": "uuid",
  "eventType": "ledger.entry.reversed",
  "eventVersion": 1,
  "correlationId": "string",
  "timestamp": "2026-06-17T00:00:00.000Z",
  "payload": {
    "ledgerEntryId": "uuid",
    "reversalOfLedgerEntryId": "uuid",
    "walletId": "uuid",
    "accountId": "uuid",
    "direction": "DEBIT",
    "money": {
      "amount": 1050,
      "currency": "USD"
    },
    "balanceAfter": {
      "amount": 11000,
      "currency": "USD"
    },
    "reason": "cashier correction approved by operations",
    "actorUserId": "uuid",
    "idempotencyKey": "string",
    "createdAt": "2026-06-17T00:00:00.000Z"
  }
}
```

### ledger.posting.rejected

```json
{
  "eventId": "uuid",
  "eventType": "ledger.posting.rejected",
  "eventVersion": 1,
  "correlationId": "string",
  "timestamp": "2026-06-17T00:00:00.000Z",
  "payload": {
    "reasonCode": "LEDGER_VALIDATION_FAILED",
    "message": "Ledger posting request failed validation.",
    "walletId": "uuid",
    "accountId": "uuid-or-null",
    "transactionType": "DEPOSIT",
    "direction": "CREDIT",
    "money": {
      "amount": 1050,
      "currency": "USD"
    },
    "reference": {
      "type": "cashier_transaction",
      "id": "uuid-or-external-id"
    },
    "idempotencyKey": "string"
  }
}
```

Event rules:

- Events are emitted only after the database transaction commits.
- Events are immutable.
- Events are append-only.
- Events are never updated.
- Corrections are represented as new events.
- Event consumers must be idempotent.
- Event order should not be assumed across different aggregate IDs.

## 11. Current Architecture Flow

Current flow:

```text
Cashier
  -> Ledger RPC
  -> Wallet Update
  -> Outbox
  -> RabbitMQ
```

Expanded current flow:

1. Cashier domain validates cashier-specific lifecycle rules.
2. The monolith calls the existing ledger posting boundary.
3. The ledger posting path calls the hardened database RPC.
4. The RPC locks the wallet row.
5. The RPC validates wallet and posting constraints.
6. The RPC inserts the immutable ledger entry.
7. The RPC updates the wallet balance atomically.
8. The domain records outbox events where applicable.
9. The outbox dispatcher publishes to RabbitMQ.

## 12. Future Ledger Service Flow

Future flow:

```text
Caller
  -> Ledger Service
  -> Existing Hardened RPC
  -> Database
  -> Outbox
  -> RabbitMQ
```

Initial Ledger Service rule:

The initial Ledger Service must wrap existing RPCs. It must not independently calculate balances.

Expanded future flow:

1. Caller validates domain-specific business rules.
2. Caller sends a command to the Ledger Service.
3. Ledger Service validates contract shape, idempotency header, and correlation metadata.
4. Ledger Service calls the existing hardened RPC.
5. Existing RPC performs wallet locking, duplicate idempotency handling, balance calculation, ledger insertion, and wallet balance update.
6. Ledger Service receives the committed ledger entry.
7. Ledger Service records or publishes ledger events through the approved outbox path.
8. RabbitMQ delivers ledger events to consumers.

## 13. Cutover Strategy

1. Contract approval.
2. Ledger Service creation from `dotnet-template-service`.
3. Service wraps existing RPCs.
4. Shadow mode validation.
5. Feature flag routing.
6. Gradual traffic migration.
7. Reconciliation validation.
8. Ownership transfer.
9. Production cutover.

Cutover gates:

- Contract tests pass for all command and query endpoints.
- Idempotency tests pass.
- Reversal tests pass.
- Event schema tests pass.
- Reconciliation reports show no balance discrepancies.
- Operational dashboards and logs include correlation IDs.
- Monolith fallback is tested before production cutover.

## 14. Rollback Strategy

Rollback requirements:

- Feature flag rollback.
- Existing RPCs remain operational.
- No data migration rollback required.
- Event processing remains idempotent.
- Reconciliation report required after rollback.

Rollback flow:

1. Disable Ledger Service routing through feature flag.
2. Route posting commands back to the monolith ledger boundary.
3. Keep existing RPCs active.
4. Continue processing idempotent events.
5. Generate reconciliation report for the affected window.
6. Review duplicate posting, rejected posting, and reversal activity.

Stage 1 rollback does not require data rollback because the Ledger Service uses the same source-of-truth RPCs.

## 15. Risks and Mitigations

Duplicate posting:

- Require `Idempotency-Key` for command endpoints.
- Preserve database idempotency checks.
- Reject same key with different payload.

Event ordering:

- Do not rely on global event order.
- Include aggregate identifiers and timestamps.
- Make consumers idempotent.

Replay handling:

- Ensure event payloads are immutable.
- Ensure consumers can safely process repeated messages.
- Track processed event IDs in consumers that mutate state.

Contract drift:

- Maintain versioned API and event contracts.
- Add contract tests before implementation.
- Require review for breaking changes.

Balance discrepancies:

- Keep balance calculation inside existing hardened RPCs during initial extraction.
- Run reconciliation before, during, and after cutover.
- Block cutover on unexplained discrepancies.

Service outages:

- Keep monolith fallback available behind a feature flag.
- Use readiness checks for database and RabbitMQ dependencies.
- Define operational alerts before production routing.

RabbitMQ outages:

- Preserve outbox durability.
- Publish only after database commit.
- Retry dispatch using existing outbox mechanics.
- Keep event consumers idempotent.

## 16. Validation Checklist

- Documentation only.
- No code changes.
- No schema changes.
- No API behavior changes.
- No Docker changes.
- No service extraction performed.
- Documentation file exists at `docs/architecture/phase-11-8-ledger-contract-specification.md`.
- Git status shows documentation-only changes.
- `git diff --check` passes.
- No runtime code modified.
- No database RPCs modified.
- No RabbitMQ changes.
- No Redis changes.
- No wallet, cashier, settlement, outbox, or auth logic modified.
- No commit created.
- No tag created.
