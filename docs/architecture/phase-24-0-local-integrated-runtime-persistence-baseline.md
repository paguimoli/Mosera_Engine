# Phase 24.0 - Local Integrated Runtime & Persistence Baseline

## Scope

Phase 24.0 establishes the local developer and QA execution baseline for real integration work. It does not enable production login, migrate users, activate Game Engine settlement consumption, move money, apply production/staging migrations, or change current platform auth behavior.

## Runtime Image vs Devtools Image

The production/runtime app image remains lean and continues to contain the built Next.js runtime plus runtime scripts and source needed by the app.

The `devtools` compose service is the canonical full-repository QA environment. It mounts the working tree at `/workspace` and includes:

- Node/npm;
- .NET SDK;
- docs;
- services;
- scripts;
- app and src;
- package files;
- database artifacts;
- git working tree access through the bind mount.

Host Node/npm and host .NET are optional for local QA when Docker is available.

## Canonical Local QA Flow

Use devtools for full repository QA:

```bash
docker compose build devtools
docker compose run --rm devtools npm run qa:devtools
```

Targeted commands:

```bash
docker compose run --rm devtools npm run qa:shadow-import
docker compose run --rm devtools npm run ops:migration-inventory
docker compose run --rm devtools npm run ops:local-runtime-inventory
docker compose run --rm devtools npm run ops:persistence-readiness-report
```

`qa:all` remains unchanged. If `QA_ADMIN_PASSWORD` or a valid admin session is missing, protected QA should report that as an environment blocker rather than using fake credentials.

## Migration Inventory Status

Migration inventory scans:

- `services/game-engine/database/`;
- `services/auth-service/database/`;
- `supabase/migrations/`;
- `database/` when present.

The inventory reports draft files, schema names, duplicate create-table risks, `create table if not exists` drift risks, alter-table coverage, trigger definitions, append-only signals, missing migration runner status, and unsafe sequencing risks.

No migration is applied by this phase.

## Persistence Readiness Status

Persistence readiness is blocked for production by design. Current status:

- Game Engine has schema artifacts and durable storage draft coverage, but runtime database repositories are not normalized for local integrated runtime.
- Auth Service has schema artifacts, repository contracts, and read-only shadow import source support, but production identity persistence repositories are not active.
- Current platform auth remains authoritative.
- Auth Service login, token issuance, session runtime, and migration execution remain disabled.
- Game Engine settlement consumer remains disabled.

## Services Currently Wired

The local compose runtime includes:

- app on `3000`;
- ledger-service on `5200`;
- credit-wallet-service on `5300`;
- settlement-service on `5400`;
- game-engine on `5500`;
- RabbitMQ on `5672` and management on `15672`;
- Redis on `6379`;
- devtools behind the `devtools` profile.

## Services Not Yet Wired

- Auth Service is not registered in the main compose runtime.
- No canonical migration runner is registered.
- No local database migration application workflow is active for Game Engine or Auth Service service schemas.

## Next Implementation Phases

Recommended sequence:

1. Select and standardize the migration runner for local, staging, and production.
2. Register Auth Service in local compose with runtime endpoints disabled.
3. Apply local-only migrations through the runner and capture evidence.
4. Implement database-backed Game Engine repositories.
5. Implement database-backed Auth Service repositories behind inactive login/token runtime.
6. Add integration tests for persistence without activating settlement or auth cutover.
