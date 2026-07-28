# Settlement Controlled Promotion Runbook

> Historical control record: the current P1 Settlement Authority does not
> permit `SETTLEMENT_AUTHORITY=SERVICE`. The promotion commands described below
> document the earlier monolith-era rehearsal workflow and must not be used as
> production cutover authority. Current promotion criteria and rollback rules
> are defined in `docs/architecture/service-contract-settlement.md` and exposed
> by `/v1/settlement/authority/readiness`.

## Current P1 Rehearsal

Run the current evidence sequence against a clean disposable database:

```bash
npm run migrations:local:run
npm run qa:settlement-input-ingestion
npm run qa:settlement-execution
npm run qa:financial-instructions
npm run qa:settlement-recovery
npm run qa:resettlement
npm run qa:settlement-evidence-classification
npm run qa:settlement-clean-promotion-rehearsal
```

The runtime must use `SETTLEMENT_AUTHORITY=MONOLITH`,
`SETTLEMENT_PRODUCTION_POSTING_ENABLED=false`, and
`SETTLEMENT_LEGACY_MUTATIONS_ENABLED=false`.

The rehearsal passes only when canonical tenant/brand scope is consistent,
orphan and unresolved historical counts are zero, Ledger/Credit readiness
passes, all selected comparisons match, and append-only rehearsal evidence is
stored. A passing rehearsal does not switch authority.

Historical exclusions require append-only classification evidence. Unknown,
inconsistent, or production-shaped records remain promotion blockers.

Rollback remains an explicit switch to `MONOLITH`. Operators must stop new
SERVICE commands, drain or classify in-flight instructions, reconcile target
services, preserve all evidence, then validate MONOLITH readiness. There is no
automatic fallback.

## Purpose

This runbook preserves the earlier operator checklist for settlement promotion
and rollback evidence. Promotion execution is superseded; simulation history
remains useful for audit.

Phase 15.0 executes Settlement authority promotion only. Ledger and Credit remain `MONOLITH`.

## Preconditions

Before simulation or promotion:

1. Confirm `SETTLEMENT_AUTHORITY=MONOLITH`.
2. Confirm `SETTLEMENT_COMPARISON_MODE=ENABLED`.
3. Confirm promotion decision is `READY_FOR_CONTROLLED_PROMOTION`.
4. Confirm `DRY_RUN_APPROVAL` exists.
5. Confirm `PROMOTION_APPROVAL` exists.
6. Confirm rollback readiness is `READY`.
7. Confirm Settlement Service health is available.

## Promotion Simulation

Run:

```bash
npm run ops:simulate-settlement-promotion
```

Expected:

- `promotionAllowed=true`
- no blockers
- authority remains `MONOLITH`
- comparison remains `ENABLED`
- outbox event `authority.promotion.simulated` exists

## Controlled Promotion

Run:

```bash
npm run ops:settlement-promote
```

Expected:

- Settlement authority becomes `SERVICE`
- Settlement comparison remains `ENABLED`
- Ledger authority remains `MONOLITH`
- Credit authority remains `MONOLITH`
- rollback readiness remains `READY`
- outbox event `authority.promoted` exists for the first promotion
- local `.env.local` contains `SETTLEMENT_AUTHORITY=SERVICE`
- local `.env.local` contains `SETTLEMENT_COMPARISON_MODE=ENABLED`

The command is idempotent. Re-running it while Settlement is already `SERVICE`
must not emit duplicate promotion events.

## Promotion Status

Run:

```bash
npm run ops:settlement-promotion-status
```

Expected:

- `authority=SERVICE`
- `comparisonMode=ENABLED`
- `rollbackReady=true`
- `promotionApprovalId` is present

## Post-Promotion Monitoring

Run:

```bash
npm run ops:settlement-post-promotion-status
```

Expected:

- `authority=SERVICE`
- `comparisonMode=ENABLED`
- `serviceHealth.available=true`
- `rollbackReadiness=READY`
- post-promotion mismatch and failure counts are reviewed
- recommendation is recorded in the release evidence package

## Rollback Trigger Analysis

Run:

```bash
npm run ops:rollback-trigger-analysis
```

Expected:

- `triggerSource=POST_PROMOTION_EVIDENCE` while Settlement authority is `SERVICE`
- raw evidence remains visible
- lifecycle-excluded QA evidence is reported in excluded counts
- promotion evidence is `READY`
- post-promotion evidence is reviewed
- rollback does not trigger solely because of excluded QA evidence

Rollback trigger hierarchy:

1. Post-promotion evidence
2. Promotion lifecycle evidence
3. Raw evidence for audit visibility only

Raw evidence must never be deleted to make trigger state look clean.

## Stabilization Window

Run:

```bash
npm run ops:settlement-stabilization-status -- --window 7d
```

Supported windows:

- `24h`
- `7d`
- `30d`
- `all`

Expected:

- Settlement authority remains `SERVICE`
- comparison mode remains `ENABLED`
- rollback readiness remains `READY`
- stabilization status is recorded
- post-promotion metrics are reviewed

Stabilization statuses:

- `STABILIZING`: evidence is still accumulating.
- `STABLE`: service authority is healthy and no active rollback condition exists.
- `REVIEW_REQUIRED`: warning-level conditions require operator review.
- `ROLLBACK_RECOMMENDED`: rollback trigger or critical parity failures are active.

Exit the stabilization window only after sustained `STABLE` status over the agreed monitoring period.

## Post-Promotion Activity Certification

Run:

```bash
npm run qa:settlement-post-promotion-activity
npm run ops:settlement-certification-status -- --window 7d
```

Expected:

- Settlement authority remains `SERVICE`
- comparison mode remains `ENABLED`
- Ledger remains `MONOLITH`
- Credit remains `MONOLITH`
- at least one post-promotion settlement comparison exists
- post-promotion mismatch count is `0`
- post-promotion failure count is `0`
- critical mismatch count is `0`
- certification status is `READY_FOR_CERTIFICATION`

Certification statuses:

- `NOT_READY`: activity or control preconditions are missing.
- `READY_FOR_CERTIFICATION`: clean post-promotion activity exists and operator certification can be considered.
- `CERTIFIED`: reserved for a future explicit operator certification action.
- `REVIEW_REQUIRED`: post-promotion parity evidence requires review.

Do not mark Settlement as certified automatically. Certification requires a future explicit operator action.

## Operator Certification Capture

Run:

```bash
npm run ops:certify-settlement -- \
  --justification "Operator reviewed stabilization evidence and certifies Settlement Service." \
  --acknowledge-warning "Operator certification is still required before marking Settlement as CERTIFIED."
```

Then confirm:

```bash
npm run ops:settlement-certification-status -- --window 7d
```

Expected:

- certification status is `CERTIFIED`
- certification approval id is present
- certified timestamp is present
- Settlement authority remains `SERVICE`
- comparison mode remains `ENABLED`
- rollback readiness remains `READY`

Certification is append-only. Do not update or delete certification history.

## Rollback Simulation

Run:

```bash
npm run ops:simulate-settlement-rollback
```

Expected:

- `rollbackAllowed=true`
- no blockers
- monolith path available
- rollback readiness `READY`
- outbox event `authority.rollback.simulated` exists

## Rollback Drill

Run:

```bash
npm run ops:simulate-settlement-rollback-drill
```

Expected:

- `drillPassed=true`
- `authorityBefore=SERVICE`
- `authorityAfter=SERVICE`
- `authorityChanged=false`
- `comparisonMode=ENABLED`
- outbox event `authority.rollback.drill.simulated` exists

The rollback drill is simulation-only. It must not change authority.

## Operator Checklist

1. Run promotion simulation.
2. Run rollback simulation.
3. Review blockers and warnings.
4. Run controlled promotion.
5. Verify promotion status.
6. Verify Settlement authority is `SERVICE`.
7. Verify Ledger and Credit authority remain `MONOLITH`.
8. Verify comparison remains `ENABLED`.
9. Verify rollback readiness remains `READY`.
10. Run post-promotion monitoring.
11. Run rollback drill.
12. Run rollback trigger analysis.
13. Run stabilization status.
14. Generate post-promotion activity certification evidence.
15. Capture operator certification when prerequisites are met.
16. Verify post-promotion QA.
17. Record results in the release evidence package.

## Emergency Rollback Procedure

Rollback must preserve:

- approval history
- promotion simulation evidence
- rollback simulation evidence
- outbox audit events
- post-action reconciliation

Emergency rollback must return authority to `MONOLITH`, keep comparison available where possible, and run reconciliation after the rollback. Rollback must not require schema migration, data restoration, or code removal.

## Hard Operator Rules

- Do not manually edit approval history.
- Do not delete simulation events.
- Do not change `SETTLEMENT_AUTHORITY` outside the approved promotion or rollback process.
- Do not disable monolith settlement.
- Do not remove rollback controls.
- Do not promote Ledger.
- Do not promote Credit.
