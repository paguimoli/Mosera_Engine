# Production Migration Governance Runbook

Production migrations are governed, manual, and fail-closed. This process does not enable production deployment or automatic migration execution.

## Required Gates

- `DEPLOYMENT_ENVIRONMENT=production`
- `MIGRATIONS_DATABASE_URL` points to the managed production PostgreSQL migration role.
- `MIGRATIONS_DATABASE_URL` is non-local and TLS-enabled with `sslmode=require`, `verify-ca`, or `verify-full`.
- `PRODUCTION_MIGRATION_BACKUP_CHECKPOINT` records the backup/PITR checkpoint.
- `PRODUCTION_MIGRATION_STAGING_REHEARSAL_EVIDENCE` records staging rehearsal evidence.
- `PRODUCTION_MIGRATION_APPROVAL_TOKEN` records the approved change ticket.
- `PRODUCTION_MIGRATION_APPROVED=true`
- `PRODUCTION_MIGRATION_DRIFT_CHECK=completed`
- `PRODUCTION_MIGRATION_DRIFT_RESULT=no-drift`

## Staging Rehearsal

1. Restore a staging database from a recent production-like backup.
2. Run the migration plan:

```bash
npm run migrations:production:plan
```

3. Run the governed dry-run:

```bash
npm run migrations:production:dry-run
```

4. Store the generated evidence JSON from `.qa/production-migration-governance`.
5. Record the evidence digest in the release/change ticket.

## Drift Detection

Before production approval, compare the target production migration history against the repository manifest.

- All planned migration files must exist.
- Checksums must match the reviewed manifest.
- No out-of-band migration should be present without DBA approval.
- Set `PRODUCTION_MIGRATION_DRIFT_CHECK=completed` only after the drift review is complete.
- Set `PRODUCTION_MIGRATION_DRIFT_RESULT=no-drift` only when the DBA confirms no blocking drift.

## Backup/PITR Checkpoint

Before approval, confirm the managed PostgreSQL provider exposes a valid recovery point.

- Capture the backup identifier or PITR timestamp.
- Confirm restore capability and retention window.
- Set `PRODUCTION_MIGRATION_BACKUP_CHECKPOINT` to the approved checkpoint identifier.

## Production Approval

Production migration dry-run requires an approved change ticket.

- Set `PRODUCTION_MIGRATION_APPROVAL_TOKEN` to the approved ticket or approval record.
- Set `PRODUCTION_MIGRATION_APPROVED=true` only after staging rehearsal, drift detection, and backup/PITR checkpoint are complete.

## Evidence Capture

Every governed run writes an evidence artifact:

```bash
npm run migrations:production:dry-run
```

The output contains:

- gate status
- database host and TLS posture
- migration plan and checksums
- staging/backup/approval references
- evidence digest
- artifact path

Attach the evidence artifact to the release/change ticket.

## Failure Handling

If any gate fails:

- do not proceed
- preserve the failed evidence artifact
- correct the missing evidence or unsafe configuration
- rerun staging rehearsal if migration inputs changed

## Rollback / Forward-Fix Strategy

Production migrations should prefer forward-fix scripts after a migration is applied. Rollback is limited to provider-level PITR restore or explicitly reviewed reversal scripts.

- Use PITR restore for catastrophic failure before traffic is resumed.
- Use forward-fix migrations for compatible schema corrections.
- Do not hand-edit production schema outside the approved process.

## Compose Runner

The production compose `migration-runner` is manual-profile only. It validates production config and runs:

```bash
npm run migrations:production:dry-run
```

It does not apply migrations in this phase.
