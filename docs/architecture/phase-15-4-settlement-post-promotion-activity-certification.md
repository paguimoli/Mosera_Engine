# Phase 15.4 - Settlement Post-Promotion Activity Certification

## Purpose

Settlement Service is already authoritative. The stabilization window now needs real post-promotion activity so operators can verify that the service remains healthy under actual comparison evidence.

This phase does not transfer any new authority. Ledger and Credit remain monolith-owned.

## Authority Constraints

- Settlement authority remains `SERVICE`.
- Settlement comparison mode remains `ENABLED`.
- Ledger authority remains `MONOLITH`.
- Credit authority remains `MONOLITH`.
- Rollback controls remain active.

## Activity Certification Flow

The QA activity harness validates authority controls, then sends a deterministic settlement comparison request to the Settlement Service. The request uses matching expected monolith results so the persisted shadow run should be `MATCH`.

The harness then reads stabilization status and confirms:

- settlements processed is greater than zero
- mismatch count is zero
- failure count is zero
- critical mismatch count is zero
- certification status is `READY_FOR_CERTIFICATION`

## Certification Statuses

`NOT_READY`

Certification preconditions are not yet met. Common causes include zero post-promotion activity or unavailable service health.

`READY_FOR_CERTIFICATION`

The system has clean post-promotion activity and is ready for explicit operator certification. This state does not mean certification has been granted.

`CERTIFIED`

Reserved for a future explicit operator certification step. This phase does not set it automatically.

`REVIEW_REQUIRED`

Post-promotion mismatches, failures, or critical parity evidence require review before certification.

## Operator Review Requirements

Before certification, operators must confirm:

- Settlement authority is still `SERVICE`
- comparison mode is still `ENABLED`
- rollback readiness is `READY`
- post-promotion activity exists
- post-promotion mismatch and failure counts are zero
- raw historical QA evidence remains retained and visible

## Validation

Run:

```bash
npm run qa:settlement-post-promotion-activity
npm run ops:settlement-certification-status -- --window 7d
```

Expected:

- activity is generated or existing clean activity is reused
- stabilization metrics show `settlementsProcessed > 0`
- certification status is `READY_FOR_CERTIFICATION`
