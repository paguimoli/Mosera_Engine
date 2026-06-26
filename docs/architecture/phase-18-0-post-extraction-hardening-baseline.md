# Phase 18.0 - Post-Extraction Hardening Baseline

## Purpose

Phase 18.0 establishes a read-only hardening baseline after Settlement, Ledger, and Credit have been promoted to service authority and certified.

This phase does not extract a new service, change authority, change routing, change financial calculations, change balances, disable comparison, or disable rollback.

## Baseline API

`GET /api/authority/baseline-status`

The endpoint is protected by admin auth and returns:

- Settlement, Ledger, and Credit authority, certification, comparison, rollback, and service health;
- overall baseline status;
- blockers and warnings;
- financial invariant report;
- rollback drill readiness summary;
- outbox and authority event audit;
- service, Redis, RabbitMQ, worker, queue, and outbox observability;
- generation timestamp.

## Status Model

`READY` means authority, certification, comparison, rollback, service health, invariants, events, and observability are within the current baseline.

`WARNING` means the promoted architecture remains available but has advisory follow-up items. Examples include outbox lag, missing direct historical ledger references for credit settlement evidence, or ledger immutability enforced by service convention rather than table-level triggers.

`BLOCKED` means a required promoted authority control failed, service health is unavailable, rollback is not ready, certification is missing, or a critical financial invariant failed.

## Financial Invariants

The baseline report evaluates existing persisted evidence only:

- credit settlement applications exist;
- ledger entries exist and are checked for references to recent settlement evidence;
- reservation exposure fields are internally consistent;
- sampled active credit wallets do not have negative available credit;
- settled reservations have settlement applications;
- recent credit-backed settlement applications are checked for ledger reference coverage;
- ledger append-only posture is reported as advisory if no table-level update/delete guard is detected.

No invariant check mutates financial records.

## Rollback Drill Summary

The baseline reuses rollback readiness evaluation for:

- Settlement;
- Ledger;
- Credit.

This is readiness reporting only. It does not execute rollback.

## Event Audit

The event audit reports:

- pending outbox count;
- failed outbox count;
- dead-letter outbox count;
- recent authority events;
- recent certification events;
- consistency warnings.

No dispatcher behavior changes are introduced.

## Service And Worker Observability

The baseline report includes:

- app health;
- database health;
- Redis health;
- Settlement Service health;
- Ledger Service health;
- Credit Wallet Service health;
- RabbitMQ queue health;
- worker heartbeat or derived activity;
- queue lag;
- outbox lag.

## Golden Path

`npm run qa:post-extraction-golden-path` wraps the existing Credit launch E2E harness and validates the promoted baseline before and after the flow.

The flow covers ticket placement, credit reservation, settlement application, accounting, commission, reconciliation, and observability without changing authority or calculation logic.

## Exit Criteria

- Settlement remains `SERVICE` and `CERTIFIED`;
- Ledger remains `SERVICE` and `CERTIFIED`;
- Credit remains `SERVICE` and `CERTIFIED`;
- comparison remains `ENABLED`;
- rollback readiness remains `READY`;
- baseline endpoint is protected and reports generated evidence;
- golden path QA passes;
- `qa:all` passes.

## Next Candidates

Future hardening or extraction candidates can be evaluated from this baseline:

- worker/outbox dispatcher isolation;
- reconciliation service extraction;
- reporting service extraction;
- cashier/payment boundary hardening;
- notification service extraction.
