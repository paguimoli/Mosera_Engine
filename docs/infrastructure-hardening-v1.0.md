# Infrastructure Hardening v1.0

## 1. Environment Strategy

The platform must use three isolated environments:

- Development
- Staging
- Production

Each environment must have separate databases, credentials, secrets, API keys, result feeds, RNG provider credentials, and storage buckets. Production data must not be used for development testing. Development work must not occur directly against production infrastructure.

Deployment flow:

1. Developer changes are built and tested in Development.
2. Validated Development changes are promoted to Staging.
3. Staging validation must pass before Production deployment.

Staging should mirror Production configuration as closely as possible without sharing production secrets or live financial data.

## 2. Containerization Strategy

Future production deployment should use containers, but this phase does not implement Docker files.

Initial service boundaries:

- Web application
- API layer
- Scheduled jobs
- Settlement workers, future
- RNG workers, future

Dockerfile strategy:

- Use minimal production images.
- Separate build and runtime stages.
- Do not bake secrets into images.
- Run as a non-root user where supported.
- Pin dependency versions.

Docker Compose strategy:

- Use for local orchestration of the web app, API, workers, and supporting services.
- Keep local secrets separate from committed configuration.
- Provide local-only defaults that cannot affect staging or production.

Kubernetes readiness:

- Design services to be stateless where possible.
- Use external managed databases and secret stores.
- Add readiness and liveness checks before production orchestration.
- Worker processes must be horizontally scalable and idempotent.

## 3. Secrets Management

Sensitive secrets include:

- Supabase credentials
- JWT secrets
- Session secrets
- RNG credentials
- External result feed credentials
- Email credentials
- MFA secrets
- Encryption keys
- Future signing keys

Rules:

- Never commit secrets.
- All sensitive configuration must be environment-driven.
- Local `.env` files are developer-only and must not be trusted as production controls.
- Production secrets should eventually be stored in a managed secret manager.
- Raw API keys should not be stored in normal database fields; store references or encrypted values.
- Signing keys remain future work and must be stored outside the application database.

## 4. Authentication Strategy

Authentication is not implemented in this phase. The future model must distinguish platform operator accounts from hierarchy participant accounts.

Platform operator roles:

- Super Admin
- Operations Admin
- Settlement Admin
- Risk Admin
- Compliance Admin
- Support Admin

Hierarchy participant account types:

- Master Agent
- Agent
- Player

Password requirements:

- Passwords must be hashed with Argon2id.
- Plaintext passwords must never be stored.
- Password reset flows must be tokenized, time-limited, and audited.

Platform operators:

- MFA mandatory.
- Shorter sessions.
- Reauthentication required for sensitive actions.

Hierarchy participants:

- MFA optional initially.
- Future market-level policy may require MFA.

Future authentication support:

- Password reset
- Session management
- Trusted devices
- Account lockout
- Break-glass accounts

Break-glass accounts must be tightly controlled, monitored, and audited.

## 5. MFA Policy

Mandatory MFA:

- Super Admin
- Operations Admin
- Settlement Admin
- Risk Admin
- Compliance Admin

Optional MFA:

- Master Agent
- Agent
- Player

Future market-level MFA policy support should allow operators to require MFA for hierarchy participants in specific markets, brands, or risk tiers.

MFA recovery must be audited. Lost-device recovery must require identity verification and operator approval.

## 6. Session Management

Session duration must reflect risk.

Platform operators:

- Shorter sessions.
- Idle timeout required.
- Reauthentication required for high-risk actions.

Hierarchy participants:

- Longer sessions may be allowed.
- Session limits should still support device tracking and account lockout.

Reauthentication required for:

- Result corrections
- Resettlement approvals
- Large manual adjustments
- Permission changes
- MFA changes
- Sensitive credential or integration changes

Session events must be logged for future audit and security review.

## 7. Logging Strategy

Logging must be structured and environment-aware.

Log domains:

- Authentication
- Settlement
- Ledger
- Resettlement
- Audit
- Integrity
- RNG
- Result posting
- Admin access
- Infrastructure jobs

Structured log fields should include:

- timestamp
- environment
- service
- action
- entity type
- entity id
- actor id, when available
- correlation id
- severity
- message
- metadata

Log retention should be defined per environment. Production logs should be retained long enough to support audit, incident response, and dispute investigation.

Future log aggregation should support centralized search, alerting, correlation IDs, and immutable archive exports.

## 8. Monitoring Strategy

Monitoring must track operational health and gambling-specific integrity risks.

Metrics:

- API errors
- API latency
- settlement failures
- settlement duration
- draw processing time
- integrity failures
- authentication failures
- resettlement activity
- RNG request failures
- result posting failures
- worker queue depth, future

Alert levels:

- info: noteworthy events that do not require immediate action
- warning: degraded behavior or elevated risk
- critical: financial, security, settlement, integrity, or availability risk requiring immediate response

Critical alerts should include:

- failed settlement for resulted drawing
- duplicate settlement attempt
- integrity hash failure
- resettlement attempt on closed period
- unusual ledger adjustment volume
- repeated authentication failures
- RNG provider failure for active game

## 9. Backup Strategy

Backup architecture must cover:

- database
- configuration
- audit records
- integrity records
- settlement records
- ledger transactions
- commission records

Recovery Point Objective (RPO):

Initial Production Target:

- RPO = 15 minutes

Meaning:

Maximum acceptable data loss after a disaster or recovery event is 15 minutes.

Examples:

- database corruption
- accidental deletion
- infrastructure failure
- credential compromise
- failed deployment

Future Targets:

- Growth Stage: RPO = 5 minutes
- Enterprise Stage: RPO < 1 minute

Recovery Time Objective (RTO):

Initial Production Target:

- RTO = 1 hour

Meaning:

Maximum acceptable downtime after a disaster or recovery event is 1 hour.

Examples:

- database restoration
- deployment rollback
- region outage
- infrastructure recovery

Future Targets:

- Growth Stage: RTO = 30 minutes
- Enterprise Stage: RTO = 15 minutes

Backup Frequency:

Initial Production:

- Automated backups
- Point-in-time recovery enabled
- Backup verification procedures documented

Restore Testing:

- Quarterly restore testing minimum
- Verify player balances
- Verify account hierarchy
- Verify settlement data
- Verify ledger integrity
- Verify audit history
- Verify integrity records
- Verify commission records

Backup Retention:

Minimum:

- Daily backups
- Weekly backups
- Monthly backups

Retention schedule must be finalized during production deployment planning.

Disaster Recovery Objective:

The platform must be capable of restoring:

- player balances
- account hierarchy
- ledger transactions
- settlement records
- audit records
- integrity records
- commission records

within the defined RTO target while remaining within the defined RPO target.

Rationale:

The current platform stage does not justify the infrastructure cost of near-zero RPO/RTO targets.

Initial targets:

- RPO = 15 minutes
- RTO = 1 hour

provide a practical balance between:

- operational risk
- infrastructure cost
- platform complexity
- recovery capability

## 10. Disaster Recovery

Database failure:

- Fail over to provider-supported recovery path.
- Restore from latest verified backup if failover is unavailable.
- Verify ledger, settlement, audit, and integrity records after recovery.

Region outage:

- Use provider region recovery procedures initially.
- Future multi-region strategy must account for settlement idempotency, database consistency, and RNG/result source coordination.

Credential compromise:

- Rotate affected credentials immediately.
- Invalidate active sessions where relevant.
- Review audit logs for misuse.
- Reissue secrets through the managed secret process.

Lost MFA device:

- Require identity verification.
- Require administrative recovery approval.
- Audit the recovery.
- Notify affected user.

Compromised admin account:

- Suspend account.
- Revoke sessions.
- Rotate affected credentials if exposed.
- Review all actions performed during suspected compromise.
- Require override review for high-risk actions.

Corrupted settlement data:

- Stop affected settlement workflows.
- Verify settlement hashes and ledger hashes.
- Identify last valid settlement state.
- Use reversal/correction workflows only.
- Do not overwrite historical records.

## 11. Restore Validation Checklist

A successful restore is not defined solely by database availability. A recovery event is considered complete only after business, financial, audit, and integrity validation have been performed.

Post-Recovery Validation:

Settlement Validation:

- settlement run counts
- settlement totals
- settlement statuses
- open settlement runs
- partially completed settlement runs

Ledger Validation:

- account balances
- operational ledger totals
- financial ledger totals
- reversal transactions
- adjustment transactions

Hierarchy Validation:

- account structure
- Super Master hierarchy
- Master Agent hierarchy
- Agent hierarchy
- Player assignments
- account visibility scopes

Commission Validation:

- commission runs
- commission records
- rollup calculations
- pending commission runs
- commission assignments

Audit Validation:

- audit event counts
- audit timeline continuity
- override approval records
- resettlement audit history

Integrity Validation:

- settlement record hashes
- ledger transaction hashes
- audit event hashes
- override approval hashes

Run:

- `verifySettlementIntegrity()`
- `verifyLedgerIntegrity()`
- `verifyAuditIntegrity()`

Investigate all integrity failures before production reopening.

Draw Result Validation:

- latest draw results
- corrected results
- voided results
- result versions
- RNG result continuity

Accounting Period Validation:

- open accounting periods
- closed accounting periods
- locked accounting periods
- pending weekly closes

Authorization Validation:

- platform operator permissions
- hierarchy visibility scopes
- restricted governance permissions
- dual-control approval rules

Recovery Completion Criteria:

Production may not reopen until:

- infrastructure restored
- database restored
- validation checks completed
- critical validation passes
- no unresolved critical integrity failures
- no unresolved financial discrepancies

For a gambling platform, restoring data is insufficient. The platform must also prove financial accuracy, settlement accuracy, audit continuity, integrity continuity, and hierarchy consistency before wagering activity resumes.

## 12. Security Governance

The platform enforces governance separation between hierarchy participants and platform operators.

Hierarchy participants:

- player
- agent
- master agent

Platform operators:

- super admin
- operations admin
- settlement admin
- risk admin
- compliance admin

Hierarchy participants are financially interested parties. They must not receive platform governance powers.

Hierarchy participants cannot receive:

- settlement.resettle
- settlement.execute
- result.correct
- override.approve
- integrity.verify
- audit.review
- rng.configure
- market.configure
- commission.recalculate

Platform operators may receive sensitive permissions only through explicit role assignment and audit-controlled workflows.

High-risk permissions should eventually require approval:

- settlement.resettle
- wallets.adjust
- override.approve
- admin.manage
- result.correct
- rng.configure

## 13. Future Cryptographic Roadmap

Future Production Security Enhancements:

- Public / Private Signing
- Key Rotation
- HSM Integration
- External Notarization

Public/private signing remains future work. It should be implemented only after:

- database schemas are stable
- canonical payload formats are stable
- hash chains are implemented
- settlement logic is complete
- ledger logic is complete
- audit export formats are defined

Likely signing targets:

- official result batches
- settlement runs
- ledger snapshots
- audit exports
- integrity verification reports

Signing keys must not live as raw database values. HSM or managed KMS integration should be evaluated before production signing.

## 14. Open Questions

Hosting model:

- Which cloud provider will host production?
- Will Supabase remain the managed database provider long-term?
- Will the web/API layer run on Vercel, containers, Kubernetes, or another platform?

Multi-region strategy:

- Is active-passive sufficient for initial production?
- Which services must be region-aware?
- What is the acceptable consistency model for draw generation and settlement?

RNG deployment model:

- Which games use internal PRNG?
- Which games use external RNG service?
- Which games use official external result feeds?
- Do internal RNG workers require isolated infrastructure?

Message queue strategy:

- Is Postgres-backed job execution sufficient for first production release?
- When should RabbitMQ or another message broker be introduced?
- What are the retry and dead-letter policies for settlement and RNG jobs?

PAM integration:

- Which PAM providers must be supported first?
- What credential exchange model is required?
- How will PAM retries interact with ticket idempotency and wallet settlement?

Operational support:

- What audit retention period is contractually required?
- What uptime target is required for rapid-draw products?
- What incident response SLA is required for settlement failures?
