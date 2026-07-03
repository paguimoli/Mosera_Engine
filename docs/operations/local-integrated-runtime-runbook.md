# Local Integrated Runtime Runbook

Phase 24.3 freezes the local runtime as a reproducible, production-like baseline for service startup, migrations, readiness, and durable Game Engine persistence.

## One-command startup

```bash
docker compose --profile local up -d --build
```

This starts the app, workers, RabbitMQ, Redis, Auth Service, Game Engine, Ledger Service, Credit Wallet Service, Settlement Service, local Postgres, and the one-shot migration runner.

## Migration behavior

- `local-postgres` starts first and must be healthy.
- `migration-runner` runs `npm run migrations:local:run` against `DATABASE_URL`.
- `game-engine` waits for local Postgres to be healthy and for `migration-runner` to exit successfully.
- Manual migration validation:

```bash
docker compose --profile devtools --profile local run --rm devtools npm run migrations:local:validate
```

## Health and readiness

- Liveness checks use `/health/live` where available.
- Readiness checks use `/health/ready` for .NET services.
- Game Engine readiness checks RabbitMQ, Redis, and `DATABASE_URL`.
- Ledger, Credit Wallet, and Settlement readiness check RabbitMQ and Redis.
- RabbitMQ and Redis have container healthchecks; dependent services wait for healthy infrastructure.
- App currently exposes `/api/health` but no dedicated readiness endpoint.

## Runtime inventory

```bash
docker compose --profile devtools --profile local run --rm devtools npm run ops:local-runtime-inventory
```

The inventory distinguishes container running state, live endpoint reachability, readiness endpoint status, dependency readiness, migration status, and Game Engine durable persistence mode.

## QA command

```bash
docker compose --profile devtools --profile local run --rm devtools npm run qa:local-integrated-runtime
```

This validates runtime health/readiness, migration freshness, Game Engine durable mode, and durable Game Engine smoke coverage.

## Teardown

Stop containers while preserving disposable local volumes:

```bash
docker compose down
```

Reset disposable local Postgres data only when a clean baseline is required:

```bash
docker compose --profile devtools --profile local run --rm devtools npm run migrations:local:reset
```

## Known limitations

- App readiness is not separated from `/api/health` yet.
- Ledger, Credit Wallet, and Settlement database dependencies are intentionally reported as `NOT_CONFIGURED` until their production persistence is wired.
- Game Engine startup still seeds deterministic local evaluation/runtime data; repeated QA passes are expected to pass, but row counts can increase after service restarts.
- This local runtime does not enable production auth enforcement, settlement posting, or production token issuance.
