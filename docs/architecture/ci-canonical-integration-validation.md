# Canonical Integration Validation

GitHub Actions is the single canonical authority for Mosera integration validation. The stable required-check name is `Canonical Integration Validation`. It must pass before a pull request can merge and before release images can be built or published.

## Runtime Model

The GitHub-hosted runner provisions disposable PostgreSQL, RabbitMQ, and Redis service containers. Application processes run on the runner with explicit loopback URLs:

- Next.js app
- Auth Service
- Game Engine
- Ledger Service
- Credit Wallet Service
- Settlement Service

The job applies every disposable local migration through the guarded migration runner, validates the resulting schema, starts the minimum integrated runtime, waits for readiness, and runs:

```text
npm run qa:local-migrations
npm run qa:auth-service-cutover
npm run qa:local-integrated-runtime
```

The migration allowlist, disposable database-name restriction, Supabase prohibition, and explicit `ALLOW_DISPOSABLE_DB_MIGRATIONS=true` confirmation remain enforced. The confirmation exists only in the isolated CI job. Production and staging migration governance are unchanged.

`AUTH_AUTHORITY`, `LEDGER_AUTHORITY`, `CREDIT_AUTHORITY`, and `SETTLEMENT_AUTHORITY` remain `MONOLITH`. CI does not enable OAuth/OIDC, MFA runtime, production authentication promotion, or production database access.

## Failure Policy

The job fails closed when:

- an infrastructure service is unhealthy;
- a migration cannot apply or validate;
- a service cannot reach readiness;
- Auth Service cutover QA fails;
- integrated runtime QA fails.

Every run uploads a compressed `canonical-integration-evidence-<run-id>-<attempt>` artifact with 30-day retention. On failure, it contains enough evidence for diagnosis without rerunning:

- `migration/`: apply output, validation report, migration 076 verification, and migration history;
- `qa/`: `qa:local-migrations`, `qa:auth-service-cutover`, and `qa:local-integrated-runtime` JSON/output;
- `services/`: Auth Service, Next.js app, Game Engine, Ledger Service, Credit Wallet Service, and Settlement Service logs;
- `infrastructure/`: PostgreSQL, RabbitMQ, and Redis diagnostics;
- `endpoints/`: liveness, readiness, and app health responses with HTTP status;
- `environment/`: an allowlisted, credential-free environment and sanitized endpoint inventory;
- `docker/`: GitHub Actions service-container inventory, inspection data, and logs;
- `status/` and `summary/`: phase markers and the generated investigation summary.

Evidence is sanitized before upload. Connection credentials and common token, password, seed, and authorization fields are redacted. The job summary identifies the failed phase, implicated service, migration status, endpoint status, first investigation point, and the uploaded artifact link.

Image publication depends on this job and cannot proceed when integration validation fails.

## Required Merge Gate

Configure the `main` branch ruleset or branch protection with:

- required status check: `Canonical Integration Validation`;
- branch must be up to date before merging;
- the check cannot be skipped or satisfied by the broader validation job;
- administrators and automation should not bypass the check except under an audited emergency process.

The workflow also listens to `merge_group`, so the same check runs for a GitHub merge queue. Repository administrators can verify the effective rule under **Settings > Rules > Rulesets** or **Settings > Branches**. A workflow file cannot create or enforce repository protection by itself; repository settings are the enforcement boundary.

## Local Compose

Docker Compose remains supported for optional local debugging and development. It is a secondary convenience path, not evidence for merge or production approval, and Docker Desktop is not required to establish repository integration validity. Production integration evidence comes exclusively from the GitHub Actions artifact attached to the canonical run.
