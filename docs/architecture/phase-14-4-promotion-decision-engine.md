# Phase 14.4 - Promotion Decision Engine

## Purpose

Phase 14.4 creates one authoritative promotion decision model for future service authority transfer decisions.

This phase does not transfer authority. Settlement remains owned by the monolith, and Settlement Service remains comparison-only.

The goal is to remove contradictory operational signals where raw shadow evidence can show blockers while lifecycle-adjusted promotion evidence is ready.

## Supported Domain

The first supported authority candidate is:

- `SETTLEMENT`

The model is intentionally shaped so `LEDGER` and `CREDIT` can be added later without inventing a second decision framework.

## Evidence Inputs

The promotion decision consumes:

- shadow readiness metrics
- shadow analysis classifications
- shadow evidence lifecycle status
- settlement authority readiness
- rollback readiness
- approval status and approval history
- current authority configuration
- comparison mode configuration
- service health status

No financial records are modified while evaluating a decision.

## Decision States

The decision engine returns one of:

- `BLOCKED`
- `READY_FOR_REVIEW`
- `READY_FOR_DRY_RUN_APPROVAL`
- `READY_FOR_PROMOTION_APPROVAL`
- `READY_FOR_CONTROLLED_PROMOTION`
- `PROMOTED`
- `ROLLBACK_RECOMMENDED`

`PROMOTED` is a descriptive state only. This phase does not promote any service.

## Decision Output

The API returns:

- domain
- current authority
- comparison mode
- dry-run mode
- raw readiness
- adjusted readiness
- promotion readiness
- rollback readiness
- approval state
- blocking reasons
- warnings
- recommendation
- evaluated timestamp

Raw readiness is retained for visibility. It is not allowed to block promotion after evidence has been lifecycle-excluded from promotion.

## Promotion Rules

Promotion is blocked when:

- promotion evidence is not `READY`
- rollback readiness is `BLOCKED`
- critical unexplained mismatches are present
- unexplained failures are present
- the candidate service health is unavailable
- comparison mode is not enabled

The engine may return `READY_FOR_DRY_RUN_APPROVAL` when:

- promotion evidence is `READY`
- rollback readiness is `READY`
- no unexplained blockers exist
- dry-run approval is missing

The engine may return `READY_FOR_PROMOTION_APPROVAL` when:

- dry-run approval exists
- dry-run evaluation passes
- promotion approval is missing

The engine may return `READY_FOR_CONTROLLED_PROMOTION` when:

- promotion approval exists
- rollback readiness is `READY`
- comparison mode is `ENABLED`
- authority is still `MONOLITH`

No automatic promotion occurs.

## Raw Evidence Policy

Raw shadow evidence remains visible because it is useful for incident review, QA traceability, and historical reconstruction.

Promotion decisions use lifecycle-effective evidence:

- `ACTIVE`
- `REVIEW_REQUIRED`

Promotion decisions exclude:

- `EXCLUDED_FROM_PROMOTION`
- `ARCHIVED`

This allows intentional QA mismatches and failures to remain immutable while no longer blocking future authority decisions.

## Operator Workflow

1. Run shadow evidence analysis.
2. Exclude classified QA evidence through the append-only lifecycle process.
3. Review the promotion decision.
4. Resolve any blocking reasons.
5. Record dry-run approval when eligible.
6. Run dry-run evaluation.
7. Record promotion approval only when dry-run evaluation is clean.
8. Keep authority set to `MONOLITH` until a future controlled promotion phase.

## API

`GET /api/authority/promotion-decision?domain=settlement`

Access is restricted to existing administrative permissions.

## Operations Command

```bash
npm run ops:promotion-decision
```

The command prints the domain, decision, recommendation, blockers, and warnings.

## Restrictions

This phase does not:

- change authority
- change routing
- change settlement calculations
- change financial ownership
- mutate historical evidence
- relax thresholds

