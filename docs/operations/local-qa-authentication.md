# Local QA Authentication

## Purpose

Local QA scripts use a shared session file so protected QA no longer depends on manual token exports in each shell.

## Session File

The bootstrap command writes:

```text
.qa/session.env
```

The file is ignored by git and contains:

- `QA_ADMIN_SESSION_TOKEN`
- `OPS_ADMIN_SESSION_TOKEN`
- `generated_at`
- `expires_at`

## Bootstrap

Run:

```bash
npm run qa:auth:bootstrap
```

Required local inputs:

```text
QA_APP_URL=http://localhost:3000
QA_ADMIN_USERNAME=admin2
QA_ADMIN_PASSWORD=<local QA password>
SUPABASE_URL=<same target used by the app>
QA_SUPABASE_URL=<optional access URL for QA tooling>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
```

The bootstrap uses the real `/api/auth/login` endpoint. It does not bypass MFA or create a test-only login path. If the QA admin has MFA enabled, bootstrap blocks and requires an operator-managed MFA workflow.

`SUPABASE_URL` is the logical target used for guardrail comparison. `QA_SUPABASE_URL` is optional and lets tooling use a different access URL for the same target. For example, when running the QA scripts inside Docker while the app target is `http://localhost:54321`, the tooling can access Supabase through `http://host.docker.internal:54321`.

## Status

Run:

```bash
npm run qa:auth:status
```

Status values:

- `READY`: app, Supabase target, QA admin, and session are usable.
- `WARNING`: non-fatal inspection issue, such as Docker target inspection unavailable.
- `BLOCKED`: QA cannot safely run.

## Composite QA

Run:

```bash
npm run qa:all
```

The runner bootstraps auth first, then runs:

- authority control QA
- shadow readiness QA
- credit launch QA
- worker observability QA

## Guardrails

The bootstrap compares the app container Supabase target with the tooling Supabase target when Docker is available. If they differ, it blocks so local and hosted Supabase targets are not mixed silently.

## Recovery

Use the local password reset utility only for existing platform users:

```bash
npm run auth:reset-password -- --username admin2 --password '<new local password>'
```

The utility does not print passwords and reports sanitized Supabase persistence diagnostics when updates fail.
