# Phase 16.6 - Ledger Post-Promotion Activity Certification

## Purpose

Ledger Service is authoritative after controlled promotion. This phase proves that clean post-promotion Ledger activity is present while comparison mode and rollback readiness remain active.

This phase does not certify Ledger operationally by itself. `CERTIFIED` is reserved for a separate explicit operator certification approval.

## Authority Constraints

- Settlement authority remains `SERVICE`.
- Settlement certification remains `CERTIFIED`.
- Ledger authority remains `SERVICE`.
- Ledger comparison mode remains `ENABLED`.
- Credit authority remains `MONOLITH`.
- Rollback controls remain active.

## Activity Certification Flow

Run:

```bash
npm run qa:ledger-post-promotion-activity
```

The harness validates the current authority state, posts a deterministic Ledger Service shadow execution request with matching expected monolith output, and then reads Ledger stabilization status.

The expected activity result is:

- Ledger Service path receives the activity request
- monolith comparison output remains active through `expectedMonolithResult`
- comparison status is `MATCH`
- persisted Ledger shadow run id is present
- post-promotion mismatch and failure counts remain zero

## Stabilization Status

Run:

```bash
npm run ops:ledger-certification-status
```

The status endpoint is:

```text
GET /api/authority/ledger-stabilization-status
```

It returns authority, comparison mode, promotion timestamp, processed Ledger activity counts, mismatch and failure counts, rollback readiness, rollback trigger state, certification status, blockers, warnings, and recommendation.

## Certification Statuses

`NOT_READY`

Certification preconditions are not met. Typical causes are zero post-promotion activity, non-service authority, disabled comparison mode, unavailable service health, or rollback not ready.

`READY_FOR_CERTIFICATION`

Ledger has clean post-promotion activity and is ready for operator review. This does not mark Ledger certified.

`CERTIFIED`

An explicit Ledger certification approval already exists. This phase does not create that approval.

`REVIEW_REQUIRED`

Post-promotion mismatches, failures, or critical parity evidence require operator review before certification.

## Operator Review Requirements

Before any later certification approval, operators must confirm:

- Ledger authority is still `SERVICE`
- Ledger comparison mode is still `ENABLED`
- rollback readiness is `READY`
- Ledger Service health is healthy
- post-promotion Ledger activity exists
- post-promotion mismatch, failure, and critical mismatch counts are zero
- Settlement remains `SERVICE` and `CERTIFIED`
- Credit remains `MONOLITH`
- historical evidence remains retained

## Next Step

After `READY_FOR_CERTIFICATION`, proceed to Phase 16.7 for explicit Ledger operator certification capture. Do not mark Ledger `CERTIFIED` automatically from activity evidence alone.
