# Reconciliation Operations Runbook

## Purpose

Reconciliation is an operational control for controlled beta readiness. It compares independently persisted records and produces reviewable findings. It must not repair financial, credit, settlement, accounting, commission, or cashier state automatically.

## Running Reconciliation

Run on demand with:

```bash
npm run ops:reconcile -- --runType FULL --weekStart 2026-06-15 --weekEnd 2026-06-22 --currency CRC
```

Required environment:

- `OPS_ADMIN_SESSION_TOKEN` or `QA_ADMIN_SESSION_TOKEN`
- `OPS_APP_URL` or `QA_APP_URL` when the app is not on `http://localhost:3000`

Useful flags:

- `--runType FULL|CREDIT|SETTLEMENT|ACCOUNTING|COMMISSION`
- `--scopeType GLOBAL|ACCOUNT|PLAYER|AGENT|MASTER|WEEK`
- `--scopeId <id>`
- `--weekStart <date>`
- `--weekEnd <date>`
- `--currency <ISO-4217>`
- `--allowFail`

By default the runner exits non-zero when any `FAIL` finding is produced.

## Severity Behavior

| Severity | Operational Meaning |
| --- | --- |
| `PASS` | No action required. |
| `WARNING` | Review required; normal operations may continue. |
| `FAIL` | Blocks launch or beta readiness until acknowledged or resolved. |

Acknowledgement means an operator has reviewed the issue and accepted that it is understood. Resolution means an operator has documented the investigation outcome. Neither action modifies source financial records.

## Operational APIs

- `GET /api/reconciliation/operations/summary`
- `GET /api/reconciliation/operations/open-findings`
- `POST /api/reconciliation/findings/{findingId}/acknowledge`
- `POST /api/reconciliation/findings/{findingId}/resolve`
- `POST /api/reconciliation/run/{runId}/review`

All endpoints require authenticated administrative authorization. They do not expose secrets, token hashes, password hashes, MFA secrets, or recovery codes.

## Acknowledging Findings

Use acknowledgement when a finding has been reviewed but still requires follow-up or when beta readiness can proceed with documented acceptance.

Operators should include:

- summary of review
- assigned operator if known
- escalation ticket or incident identifier when applicable

Acknowledgement emits:

- audit event: `RECONCILIATION_FINDING_ACKNOWLEDGED`
- outbox event: `reconciliation.finding.acknowledged`

## Resolving Findings

Use resolution only after the operator has confirmed the finding no longer requires action, or that the finding was expected and documented.

Resolution notes are required. The notes must explain the conclusion and reference supporting evidence.

Resolution emits:

- audit event: `RECONCILIATION_FINDING_RESOLVED`
- outbox event: `reconciliation.finding.resolved`

## Run Review

Run review records operator review state on a completed run. Runs with warnings or failures should be marked `REQUIRES_ATTENTION` unless the operator explicitly reviews and clears them.

Run review emits:

- audit event: `RECONCILIATION_RUN_REVIEWED`
- outbox event: `reconciliation.run.reviewed`

## Operators Must Not

- edit ledger rows
- edit ticket settlement records
- edit credit reservation amounts
- edit commission calculations
- mark findings resolved without notes
- use acknowledgement as a substitute for investigation
- treat reconciliation review metadata as a financial correction

Corrections must continue through the domain-specific reversal, adjustment, or settlement flows.

## Escalation Rules

- `FAIL` on credit exposure, settlement application, weekly accounting, or commission formula: escalate to operations lead before beta continues.
- Repeated `WARNING` in the same check code over multiple runs: escalate to engineering review.
- Missing source table or unavailable check: treat as launch-readiness risk until schema/migration state is confirmed.

## Pre-Beta Procedure

1. Run `FULL` reconciliation for the target weekly window.
2. Confirm `failedChecks` is zero.
3. Review all `WARNING` findings.
4. Acknowledge only findings with documented acceptance.
5. Resolve findings only with notes and evidence.
6. Review the reconciliation run.
7. Confirm outbox/audit records exist for review actions.
8. Attach the reconciliation summary to beta readiness notes.
