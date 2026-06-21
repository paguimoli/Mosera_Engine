# Phase 14.3 - Shadow Evidence Lifecycle Management

## Purpose

Phase 14.3 adds lifecycle classification for shadow evidence so promotion and rollback evaluation can distinguish active production-equivalent evidence from intentional QA/test evidence.

This phase does not delete, edit, or repair shadow records. It adds append-only lifecycle events beside the original evidence.

## Lifecycle Statuses

- `ACTIVE`: Evidence participates in promotion readiness.
- `REVIEW_REQUIRED`: Evidence participates in promotion readiness and requires operator review.
- `EXCLUDED_FROM_PROMOTION`: Evidence is retained but excluded from promotion readiness.
- `ARCHIVED`: Evidence is retained but excluded from promotion readiness.

Evidence with no lifecycle event defaults to `ACTIVE`.

## Reason Codes

- `QA_INTENTIONAL`
- `QA_FAILURE_TEST`
- `LOAD_TEST`
- `BACKFILL_TEST`
- `OPERATOR_EXCLUDED`
- `EXPIRED_TEST_EVIDENCE`
- `UNEXPLAINED`

## Append-Only Model

Lifecycle changes are stored in `shadow_evidence_lifecycle_events`.

Each event records:

- domain
- evidence type
- evidence id
- previous status
- new status
- reason code
- reason note
- actor user id
- correlation id
- timestamp

The migration prevents updates and deletes on lifecycle events.

## Effective Status

The current lifecycle status is computed from the latest append-only event for each evidence key:

`domain + evidenceType + evidenceId`

If no event exists, the effective status is `ACTIVE`.

## Readiness Definitions

`RAW_READINESS`: all evidence.

`ADJUSTED_READINESS`: excludes evidence classified as `QA_INTENTIONAL_MISMATCH` or `QA_INTENTIONAL_FAILURE`.

`PROMOTION_READINESS`: uses lifecycle-effective evidence only. It includes `ACTIVE` and `REVIEW_REQUIRED`, and excludes `EXCLUDED_FROM_PROMOTION` and `ARCHIVED`.

## Automatic QA Exclusion

`POST /api/shadow-evidence/lifecycle/exclude-classified-qa` appends lifecycle events for evidence classified as:

- `QA_INTENTIONAL_MISMATCH`
- `QA_INTENTIONAL_FAILURE`

The new status is `EXCLUDED_FROM_PROMOTION` with reason `QA_INTENTIONAL`.

The operation is idempotent. If evidence is already excluded, no duplicate event is created.

## APIs

Protected by existing admin permissions:

- `GET /api/shadow-evidence/lifecycle/summary`
- `GET /api/shadow-evidence/lifecycle/events`
- `POST /api/shadow-evidence/lifecycle/exclude-classified-qa`

## Promotion Evidence Rules

Authority promotion evaluation must use `PROMOTION_READINESS` for promotion-specific evidence checks. Raw readiness remains visible and must still be reviewed by operators.

Lifecycle exclusion does not weaken thresholds. It changes which retained evidence participates in promotion readiness.

## Audit Expectations

Operators must be able to reconstruct:

- original shadow evidence
- lifecycle event history
- actor responsible for lifecycle action
- reason code and note
- correlation id
- effective promotion readiness result

## Validation

Validation command:

```bash
npm run qa:shadow-evidence-lifecycle
```
