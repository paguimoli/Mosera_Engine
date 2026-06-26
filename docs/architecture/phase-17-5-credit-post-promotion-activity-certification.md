# Phase 17.5 - Credit Post-Promotion Activity Certification

## Purpose

Phase 17.5 proves that Credit Wallet Service activity has occurred after promotion while Credit remains service-authoritative, comparison remains enabled, and rollback remains ready.

This phase does not certify Credit. It prepares the domain for explicit operator certification in a later phase.

## Stabilization API

`GET /api/authority/credit-stabilization-status`

The endpoint is protected by admin auth and returns:

- authority;
- comparison mode;
- promotion timestamp;
- rollback readiness;
- Credit Wallet Service health;
- post-promotion wallet, reservation, and exposure activity counters;
- post-promotion mismatch, failure, and critical mismatch counts;
- certification status;
- certification blockers and warnings;
- recommendation.

## Certification Status

`NOT_READY` means required post-promotion conditions are not complete.

`READY_FOR_CERTIFICATION` means:

- Credit authority is `SERVICE`;
- comparison mode is `ENABLED`;
- rollback readiness is `READY`;
- Credit Wallet Service health is healthy;
- at least one post-promotion Credit wallet activity has been observed;
- post-promotion mismatch count is zero;
- post-promotion failure count is zero;
- post-promotion critical mismatch count is zero.

`READY_FOR_CERTIFICATION` does not mark Credit certified. Operator approval must be captured separately.

`REVIEW_REQUIRED` means post-promotion evidence has mismatches, failures, or critical mismatches that must be investigated.

## Activity Generation

The QA harness calls Credit Wallet Service directly through:

```text
POST /v1/credit/shadow/reserve
```

The request uses deterministic values and an expected monolith result so the service persists a `MATCH` shadow comparison after the Credit promotion timestamp. The harness is safe to rerun: each run appends clean post-promotion evidence and does not alter historical QA evidence.

## Evidence

Stabilization metrics are derived from Credit shadow runs created at or after the Credit promotion timestamp:

- `creditWalletsProcessed` counts distinct post-promotion wallet ids;
- `reservationsProcessed` counts distinct post-promotion reservation ids;
- `exposureUpdatesProcessed` counts post-promotion reserve/release or exposure-bearing comparisons;
- mismatch, failure, and critical mismatch counts use lifecycle-effective post-promotion evidence.

## Operator Workflow

1. Confirm `npm run ops:credit-post-promotion-status` is healthy.
2. Run `npm run qa:credit-post-promotion-activity` or equivalent controlled activity.
3. Confirm `npm run ops:credit-certification-status` reports `READY_FOR_CERTIFICATION`.
4. Preserve the activity evidence and stabilization output.
5. Do not mark Credit `CERTIFIED` until a later explicit certification approval phase.

## Next Phase

Phase 17.6 should capture explicit operator certification for Credit Wallet Service if the platform remains stable.
