# Phase 24.1 - Migration Runner & Disposable Local Migration Application

## Scope

Phase 24.1 selects and implements the canonical local migration runner for disposable database validation. It does not apply migrations to production, staging, or the active Supabase project. It does not enable Auth Service login, token issuance, Game Engine settlement consumption, repository wiring, or financial movement.

## Runner Decision

The canonical runner for this phase is raw SQL executed by Node scripts through the PostgreSQL `psql` client from the `devtools` container.

This is intentionally small:

- existing schema artifacts are SQL;
- Game Engine, Auth Service, and existing platform schemas all target PostgreSQL/Supabase-compatible SQL;
- local execution does not introduce EF, Flyway, Liquibase, or Supabase CLI lock-in;
- the runner can be promoted later into staging/production procedures after approval gates, drift detection, backup, rollback, and evidence capture are defined.

## Disposable Database

`docker-compose.yml` defines `local-postgres` behind the `devtools` profile. It uses:

- database: `lottery_local`;
- user: `lottery`;
- host port: `55432` by default;
- volume: `local_postgres_disposable_data`;
- healthcheck: `pg_isready`.

The `devtools` service receives:

```bash
DATABASE_URL=postgresql://lottery:lottery_dev_password@local-postgres:5432/lottery_local
ALLOW_DISPOSABLE_DB_MIGRATIONS=true
```

This database is safe to reset and is not the active Supabase project.

## Guardrails

Migration execution refuses to run when:

- `DATABASE_URL` is missing;
- the URL contains `supabase.co`;
- `NODE_ENV` or `ENVIRONMENT` is `production` or `staging`;
- the database name is not one of `lottery_local`, `lottery_test`, or `lottery_disposable`;
- `ALLOW_DISPOSABLE_DB_MIGRATIONS=true` is not set.

Status and validation may inspect without the confirmation flag, but execution and reset require it.

## Manifest Rules

The manifest lives at:

```bash
scripts/migrations/migration-manifest.json
```

Only entries classified as `apply_local` are executed. Drafts, superseded scripts, blocked scripts, and manual-review scripts are reported but excluded from automatic application.

Current classifications:

- `scripts/migrations/local/001_create_game_engine_schema.sql`: `apply_local`;
- `scripts/migrations/local/002_create_auth_service_schema.sql`: `apply_local`;
- `scripts/migrations/local/003_add_game_engine_evaluation_storage.sql`: `apply_local`;
- Game Engine and Auth Service service-schema drafts: `draft_only` or `superseded`;
- existing `supabase/migrations/*`: `manual_review_required` by rule.

## Game Engine Conflict Resolution

The known conflict between:

- `services/game-engine/database/001_game_engine_schema_draft.sql`;
- `services/game-engine/database/002_durable_evaluation_storage.sql`;

is not applied blindly. Both draft sources are excluded from automatic execution. The local runner applies a clean consolidated Game Engine baseline first, then applies evaluation storage once in `003_add_game_engine_evaluation_storage.sql`.

## Migration Tracking

The runner creates:

```sql
platform_migrations.migration_history
```

It records:

- migration id;
- filename;
- checksum;
- applied timestamp;
- status;
- duration in milliseconds;
- nullable error message.

Re-runs are idempotent: already-applied migrations with matching checksums are skipped. A checksum mismatch fails.

## Commands

Start the disposable database:

```bash
docker compose --profile devtools up -d local-postgres
```

Build devtools:

```bash
docker compose --profile devtools build devtools
```

Inspect status:

```bash
docker compose --profile devtools run --rm devtools npm run migrations:status
```

Apply local migrations:

```bash
docker compose --profile devtools run --rm devtools npm run migrations:local:run
```

Validate local migrations:

```bash
docker compose --profile devtools run --rm devtools npm run migrations:local:validate
```

Reset only the disposable schemas:

```bash
docker compose --profile devtools run --rm devtools npm run migrations:local:reset
```

Run Phase 24.1 QA:

```bash
docker compose --profile devtools run --rm devtools npm run qa:local-migrations
```

## Production Blocks

The runner is local-only. Production remains blocked until these are designed and approved:

- staging rehearsal procedure;
- production migration approval workflow;
- backup and rollback policy;
- schema drift detection;
- production evidence capture;
- durable Game Engine and Auth repository wiring;
- Auth login/token/session activation gates;
- Settlement consumer activation gates.
