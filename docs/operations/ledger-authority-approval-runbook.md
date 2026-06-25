# Ledger Authority Approval Runbook

## Purpose

This runbook describes how operators review and record Ledger authority approvals.

Ledger approval workflows are append-only and auditable. They do not change authority by themselves.

## Current Phase

Phase 16.4 supports Ledger dry-run approval capture, promotion approval capture, simulation-only controlled promotion/rollback evaluation, and explicit controlled promotion execution.

## Preconditions

Before recording Ledger dry-run approval, confirm:

- Ledger authority is `MONOLITH`.
- Ledger comparison mode is `ENABLED`.
- Ledger rollback readiness is `READY`.
- Ledger promotion decision is `READY_FOR_DRY_RUN_APPROVAL`.
- Ledger promotion evidence is `READY`.
- Raw evidence warnings have been reviewed.

Before recording Ledger promotion approval, also confirm:

- Ledger `DRY_RUN_APPROVAL` exists.
- Ledger promotion decision is `READY_FOR_PROMOTION_APPROVAL`.
- Ledger authority is still `MONOLITH`.
- Ledger comparison mode is still `ENABLED`.
- Rollback readiness is still `READY`.

## Review Commands

```bash
npm run ops:ledger-authority-readiness
npm run ops:ledger-promotion-decision
npm run ops:ledger-dry-run-evaluation
```

## Dry-Run Approval Command

```bash
npm run ops:approve-ledger-dry-run -- \
  --justification "Reviewed Ledger shadow evidence and rollback readiness." \
  --acknowledge-warning "Raw evidence is not READY and must remain visible for review." \
  --acknowledge-warning "DRY_RUN_APPROVAL is missing." \
  --acknowledge-warning "PROMOTION_APPROVAL is missing."
```

## Promotion Approval Command

```bash
npm run ops:approve-ledger-promotion -- \
  --justification "Reviewed Ledger dry-run approval, rollback readiness, and controlled promotion readiness." \
  --acknowledge-warning "Raw evidence is not READY and must remain visible for review." \
  --acknowledge-warning "PROMOTION_APPROVAL is missing."
```

## What Dry-Run Approval Does

Dry-run approval:

- Records an append-only `DRY_RUN_APPROVAL` for `LEDGER`.
- Captures actor and justification.
- Emits `authority.ledger.dry_run.approved`.
- Advances Ledger decision to promotion approval readiness.

Dry-run approval does not:

- Promote Ledger.
- Route ledger posting to Ledger Service.
- Change financial posting logic.
- Change balances.
- Disable comparison or rollback.

## What Promotion Approval Does

Promotion approval:

- Records an append-only `PROMOTION_APPROVAL` for `LEDGER`.
- Captures actor and justification.
- Emits `authority.ledger.promotion.approved`.
- Advances Ledger decision to `READY_FOR_CONTROLLED_PROMOTION`.

Promotion approval does not:

- Promote Ledger.
- Change `LEDGER_AUTHORITY`.
- Route ledger posting to Ledger Service.
- Change balances.
- Change financial posting logic.
- Disable comparison or rollback.

## Next Operator Action

After promotion approval, run Ledger promotion simulation and rollback simulation before any controlled promotion phase.

## Promotion Simulation Command

```bash
npm run ops:simulate-ledger-promotion
```

Promotion simulation verifies:

- Ledger decision is `READY_FOR_CONTROLLED_PROMOTION`.
- Ledger rollback readiness is `READY`.
- Ledger authority is `MONOLITH`.
- Ledger comparison mode is `ENABLED`.
- Ledger Service health is available.

Promotion simulation emits `authority.ledger.promotion.simulated`.

Promotion simulation does not:

- change `LEDGER_AUTHORITY`;
- route ledger posting to Ledger Service;
- change balances;
- change ledger posting logic;
- promote Ledger.

## Rollback Simulation Command

```bash
npm run ops:simulate-ledger-rollback
```

Rollback simulation verifies:

- monolith ledger path is available;
- comparison mode is enabled;
- authority controls are available;
- rollback readiness is `READY`.

Rollback simulation emits `authority.ledger.rollback.simulated`.

Rollback simulation does not:

- change `LEDGER_AUTHORITY`;
- execute rollback;
- modify approvals;
- mutate financial records.

## Controlled Promotion Command

```bash
npm run ops:ledger-promote -- \
  --justification "Reviewed Ledger controlled promotion readiness and rollback readiness." \
  --correlation-id "operator-selected-correlation-id"
```

Promotion execution requires:

- `domain = LEDGER`;
- explicit `mode = EXECUTE`;
- non-empty justification;
- Ledger decision is `READY_FOR_CONTROLLED_PROMOTION`;
- Ledger rollback readiness is `READY`;
- Ledger authority is `MONOLITH`;
- Ledger comparison mode is `ENABLED`;
- Ledger Service health is available;
- Ledger dry-run and promotion approvals exist.

When valid, promotion execution:

- changes runtime Ledger authority to `SERVICE`;
- keeps Ledger comparison mode `ENABLED`;
- keeps Settlement `SERVICE`;
- keeps Credit `MONOLITH`;
- emits `authority.ledger.promoted`;
- records actor, justification, approval id, correlation id, and timestamp.

If Ledger is already `SERVICE`, the command is idempotent and does not emit a duplicate promotion event.

The operations script persists these local runtime settings to `.env.local`:

```text
LEDGER_AUTHORITY=SERVICE
LEDGER_COMPARISON_MODE=ENABLED
```

No unrelated `.env.local` values are changed.

## Promotion Status Command

```bash
npm run ops:ledger-promotion-status
```

The status output includes:

- domain;
- authority;
- comparison mode;
- promoted timestamp;
- rollback readiness;
- promotion approval id;
- evaluation timestamp.

## Rollback Sequence

Ledger rollback execution is not part of Phase 16.4. Until rollback execution support exists, operators should:

1. Run `npm run ops:rollback-readiness`.
2. Run `npm run ops:simulate-ledger-rollback`.
3. Follow the incident runbook before changing runtime authority.
4. Preserve comparison mode and append-only audit evidence.

## Post-Promotion Validation

After controlled promotion, verify:

- Ledger authority is `SERVICE`.
- Ledger comparison mode remains `ENABLED`.
- Settlement remains `SERVICE` and `CERTIFIED`.
- Credit remains `MONOLITH`.
- rollback readiness remains `READY`.
- credit launch QA passes.
- worker observability QA passes.

## Post-Promotion Monitoring

Run:

```bash
npm run ops:ledger-post-promotion-status
```

Review:

- authority and comparison mode;
- promotion timestamp;
- Ledger Service health;
- rollback readiness;
- raw, promotion, and post-promotion evidence summaries;
- post-promotion mismatch and failure counts;
- rollback trigger source;
- operator recommendation.

Raw evidence remains visible for audit. Rollback trigger evaluation must use lifecycle-effective promotion and post-promotion evidence so excluded QA evidence does not independently trigger rollback.

## Rollback Drill

Run:

```bash
npm run ops:simulate-ledger-rollback-drill
```

The drill is simulation-only. It must not change authority, routing, balances, or ledger posting behavior.

Expected passing output:

- `drillPassed = true`
- `authorityBefore = SERVICE`
- `authorityAfter = SERVICE`
- `authorityChanged = false`
- audit event `authority.ledger.rollback.drill.simulated`

Escalate if:

- Ledger Service health is unavailable;
- rollback readiness is not `READY`;
- comparison mode is disabled;
- the drill reports an authority change;
- lifecycle-effective post-promotion mismatches or failures appear.

## Post-Promotion Activity Certification

Run:

```bash
npm run qa:ledger-post-promotion-activity
npm run ops:ledger-certification-status
```

The activity harness posts a deterministic Ledger Service comparison request after the Ledger promotion timestamp. The expected response is a persisted `MATCH` shadow run, which proves the Ledger Service path can process post-promotion activity while monolith comparison remains active.

Certification status meanings:

- `NOT_READY`: certification preconditions are not yet met.
- `READY_FOR_CERTIFICATION`: clean post-promotion activity exists and operator review can proceed.
- `CERTIFIED`: a separate explicit Ledger certification approval already exists.
- `REVIEW_REQUIRED`: post-promotion mismatches, failures, or critical evidence require investigation.

Operators must review authority, comparison mode, rollback readiness, service health, processed activity count, mismatch count, failure count, and critical mismatch count before any certification approval.

After `READY_FOR_CERTIFICATION`, proceed to the explicit Ledger operator certification phase. Do not treat activity readiness as automatic operational certification.

## Operator Certification Capture

Run certification status first:

```bash
npm run ops:ledger-certification-status
```

Certification prerequisites:

- Ledger authority is `SERVICE`;
- Ledger comparison mode is `ENABLED`;
- rollback readiness is `READY`;
- certification status is `READY_FOR_CERTIFICATION`;
- Ledger Service health is healthy;
- post-promotion failures are zero;
- post-promotion critical mismatches are zero;
- Settlement remains `SERVICE` and `CERTIFIED`;
- Credit remains `MONOLITH`.

Capture certification:

```bash
npm run ops:certify-ledger -- \
  --justification "Reviewed Ledger post-promotion activity evidence and rollback readiness." \
  --acknowledge-warning "Operator certification is still required before marking Ledger as CERTIFIED." \
  --correlation-id "operator-selected-correlation-id"
```

Certification creates an append-only `LEDGER_CERTIFICATION` approval and emits `authority.ledger.certified` through the outbox with approval id, actor user id, correlation id, and certification timestamp.

`CERTIFIED` means the operator has formally accepted Ledger Service as the certified Ledger authority after post-promotion activity validation. It does not change authority, disable comparison, disable rollback, or alter financial calculations.

After Ledger certification, the next authority domain is Credit Wallet. Begin Phase 17.0 planning with Settlement and Ledger remaining service-authoritative and certified.
