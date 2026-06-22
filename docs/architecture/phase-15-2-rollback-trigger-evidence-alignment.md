# Phase 15.2 - Rollback Trigger Evidence Alignment

## Purpose

Phase 15.2 aligns Settlement rollback-trigger evaluation with the evidence model
introduced during shadow analysis and evidence lifecycle management.

Historical raw evidence remains immutable and visible for audit, but lifecycle-
excluded QA evidence must not independently trigger rollback after Settlement has
been promoted to service authority.

## Evidence Sources

Rollback trigger reporting now distinguishes three sources.

### RAW_EVIDENCE

Raw evidence includes all Settlement shadow runs, mismatches, and failures.

Purpose:

- audit visibility
- historical traceability
- operator review

Raw evidence is never deleted or hidden. It can remain non-ready due to
intentional QA mismatch/failure records.

### PROMOTION_EVIDENCE

Promotion evidence includes lifecycle-effective evidence only.

Included lifecycle statuses:

- `ACTIVE`
- `REVIEW_REQUIRED`

Excluded lifecycle statuses:

- `EXCLUDED_FROM_PROMOTION`
- `ARCHIVED`

Purpose:

- authority promotion decisions
- rollback action evaluation after promotion

### POST_PROMOTION_EVIDENCE

Post-promotion evidence includes Settlement shadow evidence created at or after
the `authority.promoted` timestamp.

Purpose:

- post-promotion monitoring
- active rollback trigger evaluation while Settlement authority is `SERVICE`

## Trigger Hierarchy

When Settlement authority is `SERVICE`, rollback trigger evaluation prioritizes:

1. `POST_PROMOTION_EVIDENCE`
2. `PROMOTION_EVIDENCE`
3. `RAW_EVIDENCE` for audit visibility only

Raw evidence can produce warnings, but lifecycle-excluded QA evidence does not
independently trigger rollback.

## Reporting Model

`GET /api/authority/settlement-post-promotion-status` now reports:

- `triggerSource`
- `rawEvidenceSummary`
- `promotionEvidenceSummary`
- `postPromotionEvidenceSummary`
- `rollbackEvaluationDetails`

Each evidence summary includes:

- total runs
- matches
- mismatches
- failures
- critical mismatch count
- effective counts
- excluded counts
- readiness
- reasons

## Rollback Criteria

Rollback should be considered when:

- post-promotion evidence is `BLOCKED`
- promotion lifecycle evidence is `BLOCKED`
- rollback readiness is not `READY`
- Settlement Service health is unavailable
- comparison mode is disabled

Rollback should not be triggered solely because raw historical QA evidence is
non-ready after that evidence has been lifecycle-excluded.

## Operational Command

Run:

```bash
npm run ops:rollback-trigger-analysis
```

Expected output includes:

- trigger state
- trigger source
- blockers
- warnings
- raw evidence counts
- promotion evidence counts
- post-promotion evidence counts

## Current Expected State

With Settlement authority promoted:

- authority: `SERVICE`
- comparison mode: `ENABLED`
- promotion evidence: `READY`
- post-promotion evidence: `READY`
- raw evidence: visible, possibly non-ready
- aligned rollback trigger: not firing solely due to excluded QA evidence
