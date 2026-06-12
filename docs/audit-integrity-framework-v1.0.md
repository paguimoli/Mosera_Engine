# Audit & Integrity Framework v1.0

## 1. Principles

The Lottery/Keno platform is a gambling system and must treat operational, financial, settlement, ticket, result, and RNG records as high-integrity data.

Core principles:

- Critical records are immutable.
- Corrections are additive, never destructive.
- Ledger entries are append-only.
- Accepted tickets cannot be edited.
- Official results cannot be directly edited.
- Settlement is versioned and reversible only before accounting period closure.
- Sensitive admin actions require audit.
- High-risk actions require override approval.
- Hashing is used before signing.
- Public/private signing occurs after schema stabilization in Phase 4.8.

The system must protect against:

- late bets after cutoff
- ticket amount manipulation
- ticket edits after acceptance
- deleted tickets
- result manipulation
- duplicate settlement
- settlement manipulation
- unauthorized resettlement
- ledger tampering
- admin abuse
- RNG/result source manipulation

## 2. Audit Log Model

### Table Concept

Table: `audit_logs`

Purpose: immutable record of sensitive actions and changes across the platform.

### Fields

- `id`
- `entity_type`
- `entity_id`
- `action`
- `actor_type`
- `actor_id`
- `old_value`
- `new_value`
- `reason_code`
- `approval_id`
- `ip_address`
- `user_agent`
- `metadata`
- `record_hash`
- `previous_hash`
- `hash_version`
- `created_at`

### Rules

- Audit logs are append-only.
- Audit logs must not be updated.
- Audit logs must not be deleted.
- `old_value` and `new_value` should use stable JSON payloads.
- `metadata` may include request id, source system, session id, device id, or integration context.
- `approval_id` links high-risk actions to override approvals.
- Audit writes must occur inside the same transaction as the sensitive action whenever possible.

## 3. Override Approval Model

### Table Concept

Table: `override_approvals`

Purpose: records approval workflows for high-risk actions.

### Fields

- `id`
- `action_type`
- `entity_type`
- `entity_id`
- `requested_by`
- `approved_by`
- `status`
- `reason_code`
- `request_metadata`
- `approval_metadata`
- `created_at`
- `approved_at`
- `rejected_at`
- `record_hash`
- `previous_hash`
- `hash_version`

### Statuses

- `pending`
- `approved`
- `rejected`
- `cancelled`
- `expired`

### Rules

- Override approvals are append-only after approval/rejection/cancellation/expiration.
- Requester and approver should be different users for high-risk actions.
- `reason_code` is required.
- `approval_metadata` should include approval context, notes, and authentication assurance level when available.

## 4. Actions Requiring Audit

### Accounts

- create account
- update account
- move/reparent account
- status change
- credit limit change
- market/currency change

### Admin Access

- create admin user
- update admin user
- suspend admin user
- role create
- role update
- role delete
- permission assignment changes
- super admin assignment

### Markets

- create market
- update market
- deactivate market
- weekly reset configuration change

### Games

- create game
- update game
- archive game
- draw schedule change
- result source mode change
- RNG provider change

### Drawings / Results

- create drawing
- update drawing
- void drawing
- post result
- correct result
- void result

### Wagers / Pay Tables

- create wager type
- update wager type
- delete wager type
- create wager option
- update wager option
- delete wager option
- create paytable
- update paytable
- activate paytable
- deactivate paytable

### Tickets

- create ticket
- accept ticket
- cancel ticket
- void ticket
- failed ticket acceptance due to cutoff

### Ledger

- every transaction
- reversal
- manual adjustment
- zero balance credit/debit

### Settlement

- create settlement run
- complete settlement run
- fail settlement run
- reverse settlement run
- resettlement
- attempted resettlement blocked because accounting period is closed

### RNG

- provider create
- provider update
- provider suspend
- RNG request
- RNG response
- failed RNG request
- manual result source override

## 5. Accounting Period Closure Rule

Locked business rule:

Once an accounting period is closed:

```text
periodStatus = closed
```

the following actions are prohibited for transactions belonging to that accounting period:

- automated resettlement
- settlement reversal
- settlement version replacement
- commission recalculation
- weekly figure recalculation

Historical accounting periods must remain financially immutable.

If a result correction affects a closed accounting period, the system must not:

- modify original settlement records
- modify original ledger transactions
- modify original weekly figures
- modify original commission calculations

Instead, create a manual adjustment in the current open accounting period.

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

Attempted resettlement on a closed or locked period must generate an audit event:

```text
RESSETTLEMENT_BLOCKED
```

Reason:

```text
Accounting period closed.
```

The audit event should include:

- accounting period id
- accounting period status
- settlement run id
- actor admin id
- requested action
- denial error code
- timestamp

## 6. Actions Requiring Override Approval

Override approval is required for:

- result correction
- result void
- drawing void after tickets accepted
- accepted ticket void
- settlement reversal
- resettlement
- ledger reversal
- ledger manual adjustment
- zero balance correction
- granting super admin
- granting `wallets.adjust`
- granting `settlement.resettle`
- RNG provider change on active game
- manual result override

## 7. Actions Blocked By Accounting Period Closure

The following actions are not override-eligible after the affected accounting period is closed or locked:

- automated resettlement
- settlement reversal
- settlement version replacement
- historical commission recalculation
- historical weekly figure recalculation

Corrections must use current-open-period `credit_adjustment` or `debit_adjustment` transactions.

## 8. Hashing Model

### Canonical Hashing

`record_hash` is derived from stable canonical JSON fields.

Canonical hashing rules:

- Field ordering must be deterministic.
- Numeric formatting must be deterministic.
- Date/time values must use stable UTC ISO strings.
- Null and missing values must be handled consistently.
- Volatile fields are excluded.
- Hash input payload must be versioned.

### Excluded Volatile Fields

Examples of fields to exclude from canonical hashes unless explicitly part of a signed payload:

- database-generated physical metadata
- non-deterministic runtime metadata
- transient error text
- display-only computed values
- mutable cache fields

### Hash Version

`hash_version` allows future changes to canonical payload formats and hashing algorithms without invalidating historical records.

### Entities Requiring Hashes

- accepted tickets
- ticket lines
- official results
- RNG results
- ledger transactions
- settlement records
- settlement runs
- audit logs
- override approvals

## 9. Hash Chain Strategy

### Ledger

Options:

- global chain
- account-level chain
- both

Recommendation: account-level chain for first production version, plus optional global chain later.

Reason: account-level chains make account statement verification practical while preserving a path to platform-wide verification.

### Settlement

Settlement records should chain by `drawing_id` or `settlement_run_id`.

Recommendation: chain by `settlement_run_id` first, then add drawing-level verification across settlement versions for resettlement workflows.

### Results

Official results should chain by `game_id`.

Reason: result history is game-specific and draw-sequenced.

### Audit

Audit logs should use a global audit chain.

Reason: audit logs represent platform-wide chronology of sensitive actions.

### Override Approvals

Override approvals should use a global override chain.

Reason: approvals are cross-domain governance records.

### Tickets

Tickets use individual immutable record hashes at acceptance.

No chain is required initially.

Reason: tickets are immutable once accepted and are primarily verified as standalone acceptance artifacts. Ticket lines should also receive individual hashes.

## 10. Tamper Detection

### Verification Jobs

The platform should include scheduled and on-demand verification jobs:

- verify ledger hash chains
- verify settlement hash chains
- verify result hash chains
- verify audit hash chain
- verify override approval hash chain
- verify ticket record hashes
- verify RNG result hashes

### Tamper Detection Output

Tamper detection should emit records with:

- `entity_type`
- `entity_id`
- `detected_at`
- `expected_hash`
- `actual_hash`
- `severity`
- `status`

### Severity Examples

- `critical`: ledger, settlement, official result, audit, or override chain break
- `high`: accepted ticket hash mismatch
- `medium`: RNG request/result hash mismatch before posting
- `low`: non-critical metadata mismatch

### Status Examples

- `open`
- `investigating`
- `confirmed`
- `false_positive`
- `resolved`

## 11. Public / Private Signing Roadmap

Public/private signing is Phase 4.8.

It should be implemented after:

- database schema is stable
- canonical payloads are stable
- hash chains are implemented
- settlement logic is complete
- ledger logic is complete

Likely signing targets:

- official result batches
- settlement runs
- ledger snapshots
- audit exports

Reserved signing fields:

- `signature`
- `signature_key_id`
- `signature_version`
- `signed_at`

Signing guidance:

- Sign canonical hashes or hash-chain checkpoints, not mutable records.
- Keep private keys outside the database.
- Maintain key rotation metadata.
- Preserve historical verification material for retired keys.

## 12. Encryption Requirements

### Encrypted Data Categories

- admin secrets
- PAM credentials
- RNG provider API credentials
- user personal information
- sensitive integration tokens

### Rules

- Never store raw API keys directly.
- Store secret references or encrypted values.
- Encryption keys live outside the database.
- Key rotation must be planned before production.
- Access to decrypted values must be audited.
- Secret references should be stable identifiers, not secrets.

## 13. Implementation Order

Recommended order:

1. `audit_logs` schema
2. `override_approvals` schema
3. audit service
4. override workflow service
5. integrity hash utility
6. hash fields on critical tables
7. hash verification jobs
8. public/private signing in Phase 4.8

Implementation notes:

- Start with audit and override records before enabling high-risk production workflows.
- Add hash fields before enforcing hash verification jobs.
- Add signing after schemas, canonical payloads, settlement, and ledger logic stabilize.

## 14. Open Questions

- Should the first production ledger chain be account-level only, or account-level plus global checkpoints?
- How long should audit logs remain in hot storage before archival?
- Should operator-facing audit exports require signing in Phase 4.8?
- Should RNG request/response payloads be fully retained, partially redacted, or retained by reference for third-party providers?
- Should ticket line hashes be linked to ticket header hashes in a Merkle-style structure later?
