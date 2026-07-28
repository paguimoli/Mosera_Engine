# Settlement Authority Contract

## Current Authority Status

Settlement Service is the canonical implementation candidate for settlement
decisions, but production traffic remains `SETTLEMENT_AUTHORITY=MONOLITH`.
`SERVICE_SHADOW` and `SERVICE_DRY_RUN` are evidence modes. `SERVICE` is
deliberately fail-closed until the promotion blockers in this document and the
runtime readiness report are cleared.

There is no automatic fallback. A future promotion or rollback is an explicit,
approved configuration action.

## Authority Boundary

Settlement owns:

- Ingestion and validation of immutable `SettlementInput` evidence.
- Deterministic payout and settlement decision calculation.
- Immutable SettlementRecord creation and replay verification.
- Deterministic Ledger and Credit Wallet instruction intent.
- Recovery, reconciliation, reversal, and resettlement orchestration.
- Settlement idempotency, correlation, audit evidence, and operational events.

Settlement does not own:

- Outcome generation or outcome correction.
- Randomness or paytable evaluation.
- Ledger posting internals.
- Wallet balance mutation or wallet projection.
- Cashier, commission, tax, or accounting-close policy.

Ledger remains the sole financial posting authority. Credit Wallet remains the
balance and credit-exposure authority.

## Canonical Flow

The canonical decision path is:

```text
verified Math Evaluation Certificate
  -> immutable SettlementInput
  -> canonical tenant/brand scope resolution
  -> accepted wager financial context validation
  -> deterministic SettlementRecord
  -> deterministic Ledger/Credit instruction intent
  -> settlement.decision.recorded outbox event
```

SettlementRecord, the complete instruction set, execution-attempt evidence, and
the outbox event are committed in one PostgreSQL transaction. A deterministic
per-request advisory transaction lock serializes concurrent execution. A
duplicate request returns the existing record; conflicting evidence fails
closed.

### Canonical Scope

The caller supplies tenant and brand assertions, but they are not authoritative.
Settlement resolves the reservation through the Credit Wallet canonical
`wallet_scopes` boundary and validates its tenant, brand, player, and ticket
ownership before accepting the request. The resolved tenant and brand are bound
into the canonical request and scope hashes.

That immutable scope is copied into the SettlementRecord, decision evidence,
Ledger and Credit Wallet instructions, outbox payload, and every reversal or
resettlement record. A missing scope, cross-tenant or cross-brand reference, or
retry with different scope fails before financial instructions are created.

Financial instruction execution occurs after the decision transaction:

```text
Ledger instruction
  -> Ledger Service idempotent posting
  -> Credit Wallet instruction
  -> Credit Wallet idempotent application
  -> reconciliation/recovery evidence
```

Ledger executes first. Credit execution is blocked until required Ledger
evidence exists. Target calls use deterministic idempotency keys. Unknown
results require verification before retry, and failed instructions require a
governed retry. Settlement never writes Ledger or Credit Wallet tables.

The Ledger and Credit Wallet authorities own their financial outbox events.
Settlement owns only its decision event.

### Ledger Effects

Settlement produces immutable Ledger instruction intent only. Ledger effects are
created exclusively by Ledger Service and remain correlated to the settlement
instruction idempotency key.

### Retry behavior

Identical retries return existing evidence. Failed instructions require governed
retry approval; unknown target results require verification before retry.

### Failure behavior

Validation, dependency, idempotency, and evidence conflicts fail closed. A
partial target failure remains recoverable and cannot mark missing work as
financially complete.

## Lifecycle

The current append-only evidence maps to the minimum lifecycle:

| Lifecycle meaning | Durable evidence |
| --- | --- |
| Pending | accepted `settlement_requests` row |
| Evaluation in progress | settlement execution attempt |
| Settled decision | `authoritative_settlement_records` row plus financial instructions and outbox event |
| Failed or rejected | rejected ingestion or failed execution/instruction attempt |
| Awaiting recovery | recovery event with failed or unknown instruction state |
| Financially completed | all required instruction attempts are Posted or Skipped |
| Reversed | reversal SettlementRecord and opposing instructions |
| Resettled | immutable resettlement chain linking original, reversal, and corrected records |
| Cancelled or voided | cancelled resettlement request or VOID SettlementInput decision |

History is never updated or deleted. State is derived from append-only request,
attempt, recovery, reconciliation, and resettlement evidence.

## Reversal And Resettlement

The governed chain is:

```text
original SettlementRecord
  -> approved resettlement request
  -> reversal SettlementRecord
  -> opposing Ledger/Credit instructions
  -> corrected SettlementRecord
  -> corrected Ledger/Credit instructions
  -> append-only resettlement events
```

The chain preserves the original settlement, corrected SettlementInput,
certificate hashes, reason, requestor, approval metadata, timestamps,
idempotency keys, and correlation references. Duplicate requests and duplicate
execution reuse the existing chain. Historical records are immutable.

## Compatibility Surfaces

The legacy run-based persistence endpoints and shadow calculator are
compatibility or comparison surfaces only. They are mapped only when
`SETTLEMENT_LEGACY_MUTATIONS_ENABLED=true`. Production requires that setting to
be `false`; startup fails if it is enabled. The canonical SettlementInput path
never falls back to these endpoints. Their schemas remain readable for audit
and migration reconciliation.

The gated mutation routes are `/v1/settlement/runs`,
`/v1/settlement/runs/{id}/records`, `/v1/settlement/ledger-effects`, and
`/v1/settlements/shadow/calculate`.

### Historical Evidence Governance

Historical evidence is preserved. Append-only classification records identify
pre-canonical development, dry-run, synthetic QA, incomplete failed,
recoverable production-shaped, superseded, and unknown evidence.

Promotion checks may exclude only evidence proven to be non-production dry-run,
synthetic QA, pre-canonical development, or superseded evidence. Unknown,
inconsistent, or potentially production-shaped evidence remains blocking.
Recovery and reconciliation evidence is classified independently; no financial
record is deleted or rewritten.

## Readiness And Promotion

`GET /health/ready` fails closed when durable dependencies are absent and
reports:

- Database and settlement migration readiness.
- Canonical decision/intent/outbox transaction readiness.
- RabbitMQ and Redis readiness.
- Ledger and Credit Wallet dependency readiness.
- Idempotency, recovery, reconciliation, and resettlement capability.
- Authority mode and promotion blocker count.

`GET /v1/settlement/authority/readiness` additionally reports orphaned
decision/intent evidence, unresolved failed or unknown instructions, legacy
isolation, canonical scope violations, governed promotion exclusions,
unresolved historical evidence, and explicit SERVICE activation status.

SERVICE promotion requires:

1. No orphaned SettlementRecord, financial instruction set, or decision outbox event.
2. No unresolved failed or unknown-result instruction.
3. Ledger and Credit Wallet readiness and idempotency evidence.
4. Complete and consistent tenant/brand scope on promotion-eligible settlement evidence.
5. Legacy mutation endpoints disabled in production routing.
6. Approved promotion and rollback evidence.
7. Passing canonical integration, concurrency, recovery, reversal, and resettlement QA.

Rollback is explicit to `MONOLITH`; it is never automatic. Before rollback,
operators must stop new SERVICE commands, drain or classify in-flight
instructions, preserve evidence, switch authority configuration, and run
reconciliation.

## Remaining Production Blockers

- Production SERVICE activation remains intentionally disabled.
- Production posting remains intentionally disabled.
- A real promotion still requires approved operational evidence, deployment
  authorization, and a separate controlled authority-switch work package.
- Historical records not proven non-production remain blocking until recovered
  or classified through append-only governance.

## Settlement Innovation Backlog

These items are useful but not launch-critical:

- Operator dispute workbench and richer case evidence.
- Advanced multi-tenant settlement analytics.
- Automated anomaly clustering and payout-distribution alerts.
- Operator-facing reconciliation dashboards.
- Bulk governed evidence review.
- Certification-grade evidence exports.
- Performance tuning beyond measured launch capacity.
- Automated production promotion orchestration.
