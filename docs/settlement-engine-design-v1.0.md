# Settlement Engine Design v1.0

## 1. Purpose

This document defines the formal settlement engine design for the Lottery/Keno platform.

The settlement engine converts official drawing results and accepted tickets into:

- settlement records
- ticket line outcomes
- ticket statuses
- operational ledger entries
- audit records
- future commission inputs

This is documentation only. It does not implement settlement calculations, migrations, ledger entries, or application changes.

## 2. Context

The platform includes:

- accounts hierarchy
- markets
- games
- drawings
- results
- Keno draw metrics
- wager types
- wager options
- pay tables
- multi-line tickets
- financial ledger
- settlement foundation
- RNG / PRNG domain
- audit and integrity framework

Settlement must be idempotent, auditable, reversible before accounting period closure, and safe for future resettlement.

## 3. Core Settlement Pipeline

The settlement pipeline:

1. Result becomes official.
2. Draw metrics are generated.
3. Settlement run is created.
4. Eligible accepted tickets are selected by `drawing_id`.
5. Each ticket line is evaluated independently.
6. Paytable is resolved.
7. Settlement record is created per ticket line.
8. Ledger transaction is created per outcome.
9. Ticket aggregate status is updated.
10. Settlement run totals are calculated.
11. Settlement run is completed.
12. Audit and integrity records are written.

The settlement engine should run inside a controlled workflow, preferably through a transactional application service or database function once the final schema is implemented.

## 4. Settlement Run Lifecycle

Settlement run statuses:

- `pending`
- `running`
- `completed`
- `failed`
- `reversed`

Rules:

- Only one completed settlement run may exist per drawing unless controlled resettlement is authorized.
- Settlement starts only after an official result exists.
- Settlement should fail safely if required draw metrics or paytables are missing.
- Failed settlement runs are preserved for audit.
- Completed settlement runs are immutable except through reversal/resettlement workflow while the accounting period is open.

## 5. Ticket / Line Model

Tickets:

- A ticket may contain multiple lines.
- Accepted tickets are immutable.
- Ticket status is derived from line statuses.
- Ticket status should move to settled only after every eligible line has a final outcome.

Ticket lines:

- Each ticket line settles independently.
- Each line has its own wager type and optional wager option.
- Each line receives its own settlement record.
- Pending exposure is reduced as lines settle.

Line outcomes:

- `win`
- `loss`
- `push`
- `void`

## 6. Settlement Methods

### 6.1 `hit_count`

Used for:

- Standard Spots

Inputs:

- `selectedNumbers`
- `winningNumbers`

Logic:

1. Count selected numbers contained in `winningNumbers`.
2. Determine `spotCount` from selected number count.
3. Determine `hitCount` from matched selected numbers.
4. Resolve paytable row by spot count and hit count.
5. If matching paytable row has payout, line wins.
6. If no winning row matches, line loses.

Paytable lookup:

- `game_id`
- `wager_type_id`
- active paytable
- effective date
- `spot_count`
- `hit_count`

### 6.2 `hit_count_bullseye`

Used for:

- Bullseye

Inputs:

- `selectedNumbers`
- `winningNumbers`
- `bullseyeNumber`

Logic:

1. Count selected numbers contained in `winningNumbers`.
2. Determine whether selected numbers include `bullseyeNumber`.
3. Determine `spotCount`.
4. Determine `hitCount`.
5. Resolve paytable row by spot count, hit count, and Bullseye requirement.
6. If Bullseye is required, selected numbers must include the Bullseye number.

Rules:

- Bullseye number must be one of winning numbers.
- Bullseye is not an extra bonus ball.
- Bullseye is one selected number from the normal draw.

### 6.3 `metric_threshold`

Used for:

- Over
- Under

Inputs:

- draw metric
- operator
- threshold

Examples:

- `drawSum > 810`
- `drawSum < 810`

Logic:

1. Read metric from Keno draw metrics.
2. Apply comparison operator against threshold.
3. If expression is true, line wins.
4. If expression is false, line loses or pushes depending on wager rules.

Supported operators:

- `>`
- `<`
- `>=`
- `<=`
- `==`
- `!=`

### 6.4 `metric_comparison`

Used for:

- Odd / Even
- Big / Small

Inputs:

- left metric
- right metric
- operator

Examples:

- `oddCount > evenCount`
- `evenCount > oddCount`
- `highCount > lowCount`
- `lowCount > highCount`

Logic:

1. Read both metrics from Keno draw metrics.
2. Apply operator.
3. If expression is true, line wins.
4. If expression is false, line loses or pushes depending on wager rules.

### 6.5 `dragon_tiger`

Correct rule:

Dragon/Tiger is based on draw sum digits.

Definitions:

- `drawSum` = sum of all drawn numbers
- `dragonDigit` = tens digit of `drawSum`
- `tigerDigit` = ones digit of `drawSum`

Calculation:

```ts
dragonDigit = Math.floor(drawSum / 10) % 10
tigerDigit = drawSum % 10
```

Outcomes:

- `dragon` if `dragonDigit > tigerDigit`
- `tiger` if `tigerDigit > dragonDigit`
- `dt_tie` if equal

Logic:

1. Calculate or read `dragonDigit`, `tigerDigit`, and `dragonTigerResult`.
2. Compare ticket wager option code to metric result.
3. If option code matches result, line wins.
4. Otherwise, line loses.

### 6.6 `up_down`

Rules:

- `up` if `lowCount > highCount`
- `down` if `highCount > lowCount`
- `ud_tie` if equal

Logic:

1. Read `lowCount` and `highCount` from Keno draw metrics.
2. Determine `upDownResult`.
3. Compare ticket wager option code to result.
4. If option code matches result, line wins.

### 6.7 `element_count`

Default ranges for 1-80 games:

- Wood: 1-16
- Fire: 17-32
- Earth: 33-48
- Metal: 49-64
- Water: 65-80

Metrics:

- `woodCount`
- `fireCount`
- `earthCount`
- `metalCount`
- `waterCount`

Evaluation approaches:

- highest element count wins
- selected element must match `element_result`
- ties may push or resolve through product-specific rules

The first production version should define exact tie behavior per wager type before settlement is enabled.

### 6.8 `selection_match`

Used for:

- Dragon/Tiger
- Up/Down
- Elements
- Odd/Even
- Big/Small

This method is used when the draw metric already produces a named result.

Example:

- ticket option code = `dragon`
- metric result = `dragon`
- outcome = win

Logic:

1. Read named result from draw metrics.
2. Compare against ticket wager option code.
3. If equal, line wins.
4. If not equal, line loses or pushes based on configured rules.

## 7. Paytable Resolution

Lookup order:

1. `game_id`
2. `wager_type_id`
3. `wager_option_id` when applicable
4. active paytable
5. effective date
6. spot count / hit count / Bullseye flag when applicable

Rules:

- Paytables are game-specific.
- Paytables may also be wager-type-specific.
- Only one active paytable may exist for the same game, wager type, and effective period.
- Settlement should use the paytable version effective at ticket acceptance or drawing time, according to final product policy.

Missing paytable behavior:

- Settlement record should fail.
- Ticket line remains unresolved.
- Audit/error is recorded.
- Settlement run may fail or complete with failed records depending on operational policy.

## 8. Ledger Integration

Settlement creates operational ledger entries.

If line wins:

- create `win` transaction
- amount = payout or net win depending on final convention

If line loses:

- create `loss` transaction
- amount = stake

If line pushes:

- no net operational effect, or create push/refund entry depending on final convention

If freeplay loses:

- no operational loss

If freeplay wins:

- create `freeplay_win` transaction

Rules:

- Ledger entries are append-only.
- Ledger entries must not be deleted.
- Ledger entries must not be modified.
- Corrections use reversal transactions.
- Ledger transaction creation must be idempotent.
- Settlement records must link to ledger transaction ids.

Open convention:

- The platform must decide whether `win` amount stores gross payout or net win before production settlement is enabled.

## 9. Idempotency

Idempotency rules:

- One completed settlement run per drawing.
- Settlement records are unique per `ticket_line_id` and `settlement_run_id`.
- Ledger entries must use idempotency keys.
- Retries must not duplicate payouts.
- Retries must not duplicate losses.
- Settlement worker may safely retry failed jobs.

Suggested idempotency keys:

- settlement run: `settlement:${drawingId}:${resultVersion}`
- settlement record: `settlement_record:${settlementRunId}:${ticketLineId}`
- ledger entry: `ledger:${settlementRecordId}:${transactionType}`

## 10. Resettlement

Future resettlement requires override authorization.

Resettlement workflow:

1. Override approval is requested.
2. Approval captures reason code, approving admin, requested admin, and metadata.
3. Original settlement run remains unchanged.
4. Original settlement records remain unchanged.
5. Reversal settlement records are created.
6. Opposing ledger transactions are created.
7. Corrected settlement run is created.
8. Corrected settlement records are created.
9. Corrected ledger entries are created.
10. Full audit trail is maintained.

Rules:

- Never delete original settlement records.
- Never update original ledger entries.
- Reversal records must reference originals.
- Corrected records must reference previous records.

### Accounting Period Closure Rule

Locked business rule:

Once an accounting period is closed:

```text
periodStatus = closed
```

the following actions are prohibited for transactions belonging to that accounting period:

- automated resettlement
- settlement reversal
- settlement version replacement
- weekly figure recalculation
- commission recalculation

Historical accounting periods must remain financially immutable.

If a result correction affects a closed accounting period, the system must not:

- modify original settlement records
- modify original ledger transactions
- modify original weekly figures
- modify original commission calculations

Instead, the correction must be represented as a manual adjustment in the current open accounting period.

Allowed adjustment types:

- `credit_adjustment`
- `debit_adjustment`

The adjustment reason must reference:

- original accounting period
- original settlement run
- original ticket or ticket line if applicable

Example:

```text
Week 23 closed.
Player received: +100
Correct amount: +60
Difference: -40

Week 24:
debit_adjustment
amount = -40
reason = Settlement correction for closed Week 23.
```

### `canResettleSettlementRun()`

Resettlement eligibility rules:

- If accounting period status is `open`, resettlement is allowed.
- If accounting period status is `closed`, resettlement is denied.
- If accounting period status is `locked`, resettlement is denied.

Required error code:

```text
RESETTLEMENT_BLOCKED_PERIOD_CLOSED
```

Attempted resettlement against a closed or locked accounting period must not create reversal or corrected settlement records.

## 11. Audit / Integrity

Audit events:

- settlement run started
- settlement run completed
- ticket line settled
- settlement failure
- settlement reversal
- resettlement
- `RESSETTLEMENT_BLOCKED` when resettlement is attempted against a closed accounting period

Integrity fields:

- `record_hash`
- `previous_hash`
- `hash_version`

Signing fields reserved for Phase 4.8:

- `signature`
- `signature_key_id`
- `signature_version`
- `signed_at`

Rules:

- Settlement records should be hash chained by settlement run.
- Settlement runs should receive record hashes.
- Audit logs should link settlement events to run and record ids.
- Public/private signing is deferred until schemas and canonical payloads stabilize.

## 12. Failure Handling

Failure cases:

- missing draw result
- missing draw metrics
- missing paytable
- invalid wager type
- invalid wager option
- ticket after cutoff
- duplicate settlement run
- ledger creation failure
- partial settlement failure
- missing account
- missing ticket line
- invalid result source

Failure behavior:

- Record failure in settlement run or settlement record.
- Write audit log.
- Preserve partial work for investigation.
- Do not silently skip lines unless explicitly configured.
- Do not create duplicate ledger transactions on retry.
- Escalate critical failures to operations.

Partial settlement failure:

- Preferred production behavior is transactional all-or-nothing per settlement run.
- If partial record persistence is allowed, failed records must be explicit and retry-safe.
- Ledger entries must not be created for unresolved records.

## 13. Worker / Job Model

Future execution model:

- settlement job is created after result becomes official
- Postgres-backed job table initially
- worker processes settlement asynchronously
- RabbitMQ optional later
- settlement worker must be retry-safe and idempotent

Job fields:

- `id`
- `job_type`
- `entity_type`
- `entity_id`
- `status`
- `attempt_count`
- `max_attempts`
- `idempotency_key`
- `error_message`
- `created_at`
- `started_at`
- `completed_at`

Worker rules:

- Worker must acquire jobs safely.
- Worker must prevent concurrent settlement for same drawing.
- Worker must use idempotency keys for records and ledger entries.
- Worker must emit audit events.
- Worker must record failures.

## 14. Future Commission Inputs

Settlement should produce inputs for future commission logic:

- account id
- agent/master hierarchy path
- game id
- drawing id
- ticket id
- ticket line id
- stake
- payout
- net result
- funding type
- settlement record id

Commission calculation is not part of this design version.

## 15. Open Questions

- Should operational `win` ledger amount store gross payout or net win?
- Should push outcomes create explicit ledger entries or no operational ledger entry?
- Should paytable effective date be based on ticket acceptance time or drawing time?
- Should element ties push, lose, or use product-specific tie options?
- Should settlement run be all-or-nothing transactionally, or allow failed records inside completed-with-errors runs?
