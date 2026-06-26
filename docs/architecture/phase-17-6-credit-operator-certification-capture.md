# Phase 17.6 - Credit Operator Certification Capture

## Purpose

Phase 17.6 captures explicit operator certification that Credit Wallet Service has completed clean post-promotion activity validation and is accepted as the certified Credit authority.

This phase records approval only. It does not change authority, routing, balances, reservations, exposure, wallet calculations, Settlement, Ledger, comparison mode, or rollback readiness.

## API

`POST /api/authority/certification/credit`

The endpoint requires authenticated admin access by a Super Admin or Operations Admin. The request accepts:

```json
{
  "justification": "Operator review summary",
  "acknowledgedWarnings": ["..."],
  "correlationId": "optional-idempotency-key"
}
```

The endpoint creates an append-only `CREDIT_CERTIFICATION` approval record for `CREDIT`. Retries with the same `correlationId` return the original approval.

## Preconditions

Certification is allowed only when:

- Credit authority is `SERVICE`;
- Credit comparison mode is `ENABLED`;
- rollback readiness is `READY`;
- Credit promotion decision is `PROMOTED`;
- Credit stabilization status is `READY_FOR_CERTIFICATION`;
- Credit Wallet Service health is healthy;
- post-promotion Credit wallet activity exists;
- post-promotion mismatches are zero;
- post-promotion failures are zero;
- post-promotion critical mismatches are zero;
- Settlement remains `SERVICE` and `CERTIFIED`;
- Ledger remains `SERVICE` and `CERTIFIED`;
- operator justification is supplied;
- current certification warnings are acknowledged.

## Approval And Audit Trail

The approval uses the shared authority approval table:

- `authorityCandidate`: `CREDIT`;
- `approvalType`: `CREDIT_CERTIFICATION`;
- actor user id and username are captured;
- metadata preserves warning acknowledgements, correlation id, prior certification status, activity counts, and upstream Settlement/Ledger certification state.

The API emits only the append-only outbox event:

```text
authority.credit.certified
```

The payload includes approval id, actor user id, correlation id, and certification timestamp. No direct broker publish occurs.

## Status Integration

`GET /api/authority/credit-stabilization-status` returns `CERTIFIED` after a `CREDIT_CERTIFICATION` approval exists, together with:

- `certificationApprovalId`;
- `certifiedAt`.

`CERTIFIED` means operator review accepted the post-promotion Credit evidence. It does not imply comparison can be disabled or rollback can be removed.

## Operator Workflow

1. Confirm `npm run ops:credit-certification-status` reports `READY_FOR_CERTIFICATION`.
2. Preserve post-promotion activity evidence and clean mismatch/failure metrics.
3. Run `npm run ops:certify-credit -- --justification "..." --acknowledge-warning "..."`.
4. Confirm Credit stabilization reports `CERTIFIED`.
5. Preserve the approval id, outbox event, actor, timestamp, and status output.

## QA

`npm run qa:credit-certification` verifies auth, required justification, required warning acknowledgement, valid certification capture, idempotency, append-only approval behavior, outbox emission, and that Credit financial state and authority controls do not change.

## Next Phase

Phase 18 should continue Credit post-certification monitoring and define any future controlled changes separately. Comparison mode and rollback readiness remain active until an explicit later phase changes them.
