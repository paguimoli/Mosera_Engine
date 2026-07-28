# Outcome Authority Operations Runbook

P0-007.13 keeps production Outcome Authority disabled. These procedures define fail-closed operations evidence and escalation paths only.

## Emergency Disable

- Set the Outcome Authority activation guardrail to disabled.
- Record operator, reason, affected provider, and evidence hash.
- Confirm readiness reports show production activation blocked.
- Do not supersede outcomes without dual approval.

## Failed Entropy Or DRBG Health

- Stop outcome generation attempts for the affected provider.
- Verify the configured entropy provider id/version matches the runtime OS provider.
- Run DRBG conformance QA and capture evidence.
- Keep production readiness blocked until conformance and entropy readiness pass.

## Nonce Conflict

- Fail closed for the affected request scope.
- Preserve nonce conflict evidence and runtime request idempotency records.
- Resume only after duplicate/reused nonce scope is explained and corrected.

## Seed Compromise

- Treat all affected provider sessions as disputed.
- Disable affected provider configuration.
- Preserve reveal/custody evidence.
- Rotate seeds only through an approved future custody process.

## Signing-Key Compromise

- Disable affected signing provider.
- Mark affected signatures as requiring verification review.
- Preserve chain references and do not rewrite certificates.
- Rotate keys only after KMS/HSM custody is commissioned.

## Official Result Conflict

- Fail closed on conflicting external official result evidence.
- Record source, schema mapping, signature validation result, and conflict hash.
- Require supersession workflow before replacement evidence is accepted.

## Physical Draw Dispute

- Preserve witness, equipment, custody, and draw event evidence.
- Mark outcome custody as Disputed where applicable.
- Require dual approval for void, replay, or supersession controls.

## Outcome Supersession

- Never edit original outcome/certificate records.
- Publish a `Corrected` version referencing the exact current
  `outcome_version_id`.
- Confirm the corrected version uses a different verified Outcome Certificate
  hash.
- Preserve chain roots, signatures, operator, reason, and approval metadata.
- Confirm one `outcome.corrected` and one `settlement.requested` event exist in
  `public.outbox_events`.

## Outcome Cancellation

- Publish a `Cancelled` version referencing the exact current
  `outcome_version_id`.
- Do not attach a financial `SettlementInput` to the cancellation request.
- Confirm one `outcome.cancelled` event and one `settlement.requested` event
  were committed.
- Treat cancellation as terminal. A new result requires a governed new draw,
  not mutation of the cancelled chain.

## Publication Recovery

- Query `game_engine.canonical_outcome_versions` by draw and order by
  `version_number`.
- Confirm every version has exactly one linked outbox event.
- Query `game_engine.outcome_settlement_requests`; at most one request may
  exist per outcome version.
- Retry with the original idempotency key and payload. The original durable
  record must be returned.
- Stop and investigate if the same idempotency key produces a canonical hash
  conflict, a version skips its predecessor, or a non-current version attempts
  Settlement emission.
- Never insert directly into Settlement as a publication recovery shortcut.

The Game Engine recovery loop and
`POST /api/game-engine/outcome-publications/recover` perform two bounded,
advisory-locked actions:

1. create a missing `settlement.requested` record and outbox event for the
   current canonical outcome version after verifying its exact
   `SettlementInput`;
2. requeue an old `PUBLISHED` request event that has no consumption receipt,
   preserving the original outbox event identifier.

Each action appends evidence to
`game_engine.canonical_outcome_recovery_events`. Recovery never calls
Settlement directly and stops after five unconfirmed requeues.

## Worker Topology

- `outbox-dispatcher` polls `public.outbox_events` and publishes to the existing
  RabbitMQ topic exchange.
- `worker-settlement` owns the Settlement workload queue and consumes
  `settlement.requested`.
- Both workers run compiled JavaScript from `worker-dist` through
  `runtime-bootstrap.cjs`. Production startup does not invoke `npm` or load
  TypeScript.
- Consumers reconnect after RabbitMQ disconnects. The dispatcher reuses one
  publisher connection and reconnects through the publisher adapter.
- `game_engine.canonical_runtime_components` records current compiled-runtime
  readiness; it is operational state, not authority evidence.

## Replay And Completion

- A worker receipt is unique by Settlement request and outbox event.
- Redelivery with the same canonical message hash returns the existing receipt.
- Conflicting redelivery, stale outcome versions, or mismatched certificate and
  `SettlementInput` evidence fail closed.
- Draw completion is appended only in the same transaction as the first valid
  Settlement request consumption.
- Restarting the dispatcher, Settlement worker, RabbitMQ, or Game Engine does
  not create another request, receipt, or completion record.
- Run `npm run qa:canonical-draw-orchestration` against the local integrated
  runtime to exercise restarts, reconnect, duplicate delivery, and recovery.

## Crash Recovery

- Restart Game Engine.
- Verify durable idempotency returns the existing request state.
- Confirm advisory locks are released.
- Confirm fresh DRBG session evidence before any new dry-run generation.
- Ensure no duplicate outcomes, certificates, or receipts were created.

## Rollback Detection

- Compare startup watermark sequence and previous chain root.
- Fail closed on sequence regression, chain mismatch, or missing evidence.
- Treat restored snapshots as unsafe until reconciliation evidence is captured.

## Activation Rehearsal

- Run all P0-005 and P0-007 QA.
- Confirm provider, entropy, DRBG, signing, statistical, recovery, and custody sections are present.
- Confirm production activation remains disabled.
- Confirm no test/simulation provider is production eligible.
- Run `npm run qa:canonical-outcome-pipeline`.
- Run `npm run qa:canonical-draw-orchestration`.
- Confirm readiness reports canonical persistence, advisory locking, shared
  outbox, compiled workers, RabbitMQ consumption, replay protection,
  missing-request recovery, and legacy publication disabled.
- Confirm production Outcome Authority remains disabled.
