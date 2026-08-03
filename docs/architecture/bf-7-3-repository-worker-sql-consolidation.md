# BF-7.3 Repository, Worker, and SQL Consolidation

## Decision

Production persistence and background execution use the ownership metadata in `cross-service-contracts.ts` as their single readiness source. This metadata does not execute work; it identifies the existing canonical implementation for repository, worker, and SQL boundaries.

## Repository Consolidation

- Canonical ticket persistence remains `canonical-ticket.repository.ts`.
- The legacy ticket controller/service/repository cluster remains isolated to the existing diagnostic UI compatibility surface. Production routes and workers use only canonical ticket persistence.
- Outbox callers use `outbox.service.ts`, which selects the durable PostgreSQL adapter when `DATABASE_URL` is configured.
- Ledger-reference remediation no longer bypasses the canonical Outbox selector.
- Aggregate-specific service repositories remain separate where they own different tables or transaction boundaries. They are not interchangeable write implementations.

## Worker Consolidation

- `outbox-dispatcher` is the only production Outbox execution identity.
- The authenticated one-shot Outbox mutation route is retired.
- All RabbitMQ workload categories use `consume-workload.ts`, with one category-specific container identity and queue binding.
- Game Engine outcome recovery and Credit Wallet startup recovery remain service-owned hosted workers because their responsibilities do not overlap queue consumption.
- Operations endpoints observe workers but do not execute worker responsibilities.

## SQL Consolidation

- Applied migrations remain immutable evidence and are not rewritten when a later migration supersedes a function definition.
- Canonical SQL ownership is determined from the deployed schema and the latest authority migration.
- QA rejects duplicate deployed routine signatures in authoritative schemas.
- Immutable triggers, validation functions, and authority entry points remain owned by their domain schema.

## Readiness

Application readiness reports `repositoryWorkerSqlIntegrity` from the existing cross-service boundary registry. Readiness requires unique implementation identities for repositories, workers, and SQL authorities alongside contract and event integrity.

## Compatibility Boundary

The legacy `public.apply_credit_settlement` overload remains a non-authoritative compatibility adapter for historical monolith QA. Canonical production wallet execution uses `credit_wallet_service` operations through Credit Wallet Authority. Removing the compatibility overload requires a separately governed retirement of legacy comparison QA and is not performed by BF-7.3.
