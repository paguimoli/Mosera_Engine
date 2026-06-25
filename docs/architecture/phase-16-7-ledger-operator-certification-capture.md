# Phase 16.7 - Ledger Operator Certification Capture

## Purpose

Ledger Service has completed post-promotion activity validation. This phase captures formal operator certification that Ledger Service is accepted as the certified Ledger authority.

Certification is append-only evidence. It does not change authority, comparison mode, rollback readiness, balances, Ledger calculations, Settlement logic, or Credit logic.

## Certification Approval

Ledger certification records use:

```text
authority_candidate = LEDGER
approval_type = LEDGER_CERTIFICATION
```

Approval records are immutable. The database prevents updates and deletes, and the certification API only inserts new approval evidence unless an existing record is found by the same correlation id.

## Certification API

```text
POST /api/authority/certification/ledger
```

Input:

```json
{
  "justification": "Reviewed Ledger post-promotion activity evidence.",
  "acknowledgedWarnings": [
    "Operator certification is still required before marking Ledger as CERTIFIED."
  ],
  "correlationId": "operator-selected-correlation-id"
}
```

The endpoint requires authentication, `system.admin`, and membership in either `Super Admin` or `Operations Admin`.

## Preconditions

Certification is allowed only when:

- Ledger authority is `SERVICE`
- Ledger comparison mode is `ENABLED`
- rollback readiness is `READY`
- Ledger certification status is `READY_FOR_CERTIFICATION`
- Ledger Service health is healthy
- post-promotion failures are zero
- post-promotion critical mismatches are zero
- Settlement remains `SERVICE` and `CERTIFIED`
- Credit remains `MONOLITH`

## Audit Trail

Successful certification creates an append-only approval record and emits one outbox event:

```text
authority.ledger.certified
```

Payload:

- `approvalId`
- `actorUserId`
- `correlationId`
- `certifiedAt`

The flow uses the outbox only. It does not directly publish to RabbitMQ.

## Meaning Of Certified

`CERTIFIED` means operators have formally accepted the Ledger Service authority after clean post-promotion activity validation. It does not disable comparison mode or rollback controls.

## Next Domain

After Ledger is certified, the next authority domain is Credit Wallet. Phase 17.0 should begin Credit Wallet transfer planning while keeping Settlement and Ledger certified and service-authoritative.
