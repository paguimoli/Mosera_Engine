# Phase 18.3 - Operator-Reviewed Ledger Reference Remediation Framework

Phase 18.3 adds an operator governance workflow for ledger reference remediation
evidence. It does not repair references, update financial rows, rewrite history,
or alter authority routing.

## Scope

The framework consumes the Phase 18.2 ledger reference remediation report and
projects an append-only review queue. Queue entries are generated from evidence
and approval records. Financial tables are never updated by this phase.

## Remediation Queue

Each queue candidate includes:

- remediation id
- source domain and source entity id
- affected settlement, reservation, ticket, ledger, and correlation evidence
- probable target when one can be inferred
- confidence score and confidence band
- discovery reason
- discovered timestamp
- workflow status

Statuses are derived from append-only approval records:

- `NEW`: no operator review has been recorded
- `UNDER_REVIEW`: review has been started
- `APPROVED`: operator approved an advisory remediation plan
- `REJECTED`: operator rejected the candidate
- `COMPLETED`: investigation is closed; no repair is implied
- `EXPIRED`: candidate aged beyond the review window without closure

`COMPLETED` means only that the investigation and audit workflow are closed. It
does not mean ledger entries, settlement records, credit records, references,
balances, exposure, reservations, or accounting records were changed.

## APIs

- `GET /api/operations/ledger-reference-remediation/queue`
- `GET /api/operations/ledger-reference-remediation/queue/{remediationId}`
- `GET /api/operations/ledger-reference-remediation/summary`
- `GET /api/operations/ledger-reference-remediation/execution-plan/{remediationId}`
- `POST /api/operations/ledger-reference-remediation/approvals`

All endpoints require `system.admin`. Approval capture is restricted to Super
Admin and Operations Admin operators.

## Approval Capture

Remediation decisions are captured through the existing authority approval table
with Ledger as the authority candidate and remediation metadata that identifies
the workflow. Approval records are append-only and idempotent by correlation id.

The approval outbox event is:

```text
operations.ledger_reference_remediation.review_recorded
```

The event records the remediation id, operator, decision, resulting status,
correlation id, and the fact that financial mutation is not allowed.

## Execution Plans

Execution plans are advisory only. They describe:

- records involved
- probable repair concept
- confidence and risk
- dependencies
- expected impact
- validation checklist
- rollback considerations

The plan performs no repair and has `mutationAllowed = false`.

## Protection Rules

This phase never:

- updates ledger entries
- updates settlements
- updates credit settlement applications
- changes balances
- changes reservations
- changes exposure
- changes accounting
- changes authority
- dispatches remediation automatically
- backfills historical references

Any future historical repair requires a separate phase with explicit
architecture approval, operator authorization, QA, audit trail, and rollback
strategy.
