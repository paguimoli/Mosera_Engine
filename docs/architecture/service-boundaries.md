# Service Boundaries

## Current Architecture

The platform currently runs as a Next.js application with domain modules under
`src/domains`, App Router API routes under `app/api`, and Supabase/Postgres as
the operational database. Domain services own business rules in TypeScript,
while recent hardening moved durable background work into outbox/job tables and
financial posting into the database through `post_financial_ledger_entry`.

This phase does not move code. It defines ownership boundaries and contracts so
future services can be extracted without changing business behavior first.

## Target Architecture

The target architecture is service-oriented:

- Each service owns its tables and write model.
- Other services use commands/contracts for cross-service writes.
- Cross-service notifications are emitted as events through the outbox.
- Postgres remains the source of truth for durable state.
- RabbitMQ or another broker becomes transport, not storage.
- Next.js keeps the admin UI, back-office workflows, and BFF/API gateway role
  during migration.

## .NET Migration Priority

1. LEDGER_SERVICE
2. WALLET_SERVICE
3. CASHIER_SERVICE
4. SETTLEMENT_SERVICE
5. DRAW_SERVICE
6. PAM_SERVICE
7. ACCOUNTING_SERVICE
8. COMMISSION_SERVICE

Ledger and wallet move first because they protect money movement and already
have clearer transactional boundaries. Cashier follows because it depends on
ledger and wallet posting. Settlement and draw services follow because they
generate high-volume financial outcomes. PAM integration comes after the core
wallet/ledger boundaries are stable.

## Next.js Retained Responsibilities

Next.js should retain these longer:

- Admin UI
- Back-office screens
- Configuration management
- BFF/API gateway role during migration
- Temporary internal worker trigger routes until dedicated workers exist

## Table Ownership Map

| Service | Owned resources |
| --- | --- |
| AUTH_SERVICE | `platform_users`, `user_sessions`, `platform_sessions`, MFA tables, password reset tables, `oauth_clients`, `oauth_access_tokens`, auth audit and break-glass tables |
| ACCOUNT_SERVICE | `accounts` |
| MARKET_SERVICE | `markets` |
| BRAND_SERVICE | `brands` |
| PLAYER_SERVICE | `player_profiles` |
| WALLET_SERVICE | `financial_wallets` |
| LEDGER_SERVICE | `financial_ledger_entries`, `post_financial_ledger_entry`, `reverse_financial_ledger_entry` |
| CASHIER_SERVICE | `cashier_transactions` |
| ACCOUNTING_SERVICE | `weekly_accounting_periods`, `weekly_account_summaries` |
| COMMISSION_SERVICE | `commission_plans`, `commission_plan_rules`, `account_commission_assignments`, `weekly_commission_records` |
| WORKER_SERVICE | `outbox_events`, `job_runs`, `idempotency_keys` |
| DRAW_SERVICE | Future persisted draw/game/result configuration tables |
| SETTLEMENT_SERVICE | Future persisted ticket, wager, result, settlement, and resettlement tables |
| PAM_SERVICE | Future PAM integration transaction and balance tables |
| REPORTING_SERVICE | Future reporting read models and export tables |
| NOTIFICATION_SERVICE | Future notification and webhook delivery tables |

The TypeScript source of truth for this map is
`src/architecture/service-boundaries/service-ownership.map.ts`.

## Allowed Dependencies

Allowed service dependencies are defined in
`src/architecture/service-boundaries/service-dependency.rules.ts`.

Core rules:

- `CASHIER_SERVICE` may call `LEDGER_SERVICE`, `WALLET_SERVICE`, and
  `ACCOUNT_SERVICE`.
- `LEDGER_SERVICE` may call `WALLET_SERVICE`.
- `WALLET_SERVICE` may call `ACCOUNT_SERVICE`.
- `SETTLEMENT_SERVICE` may call `LEDGER_SERVICE`, `WALLET_SERVICE`, and
  `DRAW_SERVICE`.
- `ACCOUNTING_SERVICE` may call `LEDGER_SERVICE`, `WALLET_SERVICE`, and
  `ACCOUNT_SERVICE`.
- `COMMISSION_SERVICE` may call `ACCOUNTING_SERVICE` and `ACCOUNT_SERVICE`.
- `PAM_SERVICE` may call `LEDGER_SERVICE` and `WALLET_SERVICE`.
- `REPORTING_SERVICE` may read operational services but must not mutate their
  operational tables.

## Dependency Rules

- UI must not call repositories directly.
- Services must not write tables owned by another service.
- Cross-service writes must happen through commands/contracts.
- Cross-service notifications should happen through events/outbox.
- Reporting may read but should not mutate operational tables.

## Event-Driven Communication Rules

Events describe facts that already happened. They should be named in the past
tense, include aggregate identity, carry a correlation id when available, and be
safe for consumers to process more than once.

Consumers must be idempotent. Event handlers should use idempotency keys or
consumer-side processing registries before mutating state.

## Outbox Usage Rules

The outbox is durable pending work. Business services write outbox events in
the same durable path as the business state they describe whenever possible.
Workers dispatch pending events later and mark them `PUBLISHED`, `FAILED`, or
`DEAD_LETTER`.

Outbox events are never deleted as part of normal dispatch. Failed events are
retryable. Permanently failed events become dead-letter records for operations
review.

## RabbitMQ Future Role

RabbitMQ will provide asynchronous transport between services and workers. It
should not become the source of truth for business state or pending financial
work. If RabbitMQ is unavailable, durable pending work remains visible in
Postgres through the outbox.

## Database Source Of Truth

The database remains authoritative because it owns transactions, constraints,
idempotency records, ledger immutability, wallet balances, and worker progress.
Queues move messages; the database records what happened and what still needs
to happen.
