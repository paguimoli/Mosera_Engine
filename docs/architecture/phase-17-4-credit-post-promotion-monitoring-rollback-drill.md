# Phase 17.4 - Credit Post-Promotion Monitoring and Rollback Drill

## Purpose

Phase 17.4 adds Credit Wallet post-promotion monitoring and rollback drill evidence after Credit Wallet Service becomes authoritative.

This phase does not execute rollback. It monitors the promoted service-authoritative state, evaluates rollback readiness, simulates rollback drill controls, and records append-only audit evidence.

## Monitoring API

`GET /api/authority/credit-post-promotion-status`

The endpoint is protected by admin auth and reports:

- Credit authority and comparison mode;
- promotion timestamp;
- Credit Wallet Service health;
- rollback readiness and rollback trigger;
- post-promotion credit wallet, reservation, and exposure activity counters;
- post-promotion mismatch, failure, and critical mismatch counts;
- lifecycle-adjusted rollback evidence;
- operator recommendation.

Historical intentional QA evidence remains visible in raw evidence but is excluded from aligned post-promotion rollback trigger evaluation.

## Recommendation Model

Recommendations follow the Settlement and Ledger post-promotion pattern:

- `BLOCKED` when Credit is not service-authoritative or comparison is disabled.
- `ROLLBACK_RECOMMENDED` when Credit Wallet Service health is unavailable or aligned rollback trigger conditions are active.
- `REVIEW_REQUIRED` when rollback readiness is not ready, aligned evidence requires review, or no post-promotion Credit activity has been observed yet.
- `CONTINUE_MONITORING` when Credit Service remains authoritative with comparison enabled, rollback ready, and aligned evidence clear.

Credit remains in `REVIEW_REQUIRED` until operators have reviewed sufficient post-promotion activity.

## Rollback Drill API

`POST /api/authority/credit-rollback/drill`

Payload:

```json
{
  "mode": "SIMULATION",
  "correlationId": "optional-stable-id"
}
```

The drill:

- requires authenticated admin access;
- supports only `mode: "SIMULATION"`;
- verifies Credit authority is `SERVICE`;
- verifies comparison mode is `ENABLED`;
- verifies rollback readiness is `READY`;
- verifies Credit Wallet Service and monolith paths remain available;
- never changes authority;
- never changes balances, reservations, exposure, wallet calculations, Settlement, or Ledger;
- emits `authority.credit.rollback.drill.simulated` through the outbox.

The outbox event captures actor user id, correlation id, created timestamp, validation blockers, warnings, and drill result.

## Operations

Review monitoring status:

```bash
npm run ops:credit-post-promotion-status
```

Run a simulation-only rollback drill:

```bash
npm run ops:simulate-credit-rollback-drill -- \
  --correlation-id "change-credit-rollback-drill-001"
```

## Exit Criteria

Before moving to the next Credit certification-readiness phase, operators should confirm:

- Credit authority remains `SERVICE`.
- Credit comparison remains `ENABLED`.
- rollback readiness remains `READY`.
- Settlement remains `SERVICE` and `CERTIFIED`.
- Ledger remains `SERVICE` and `CERTIFIED`.
- post-promotion Credit activity is present and reviewed.
- post-promotion critical mismatches are zero.
- post-promotion failures are zero.
- rollback drill evidence exists and shows no authority or financial-state mutation.

## Next Phase

Phase 17.5 should generate and certify real post-promotion Credit activity while Credit Wallet Service remains authoritative.
