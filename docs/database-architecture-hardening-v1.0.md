# Lottery/Keno Database Architecture & Hardening Blueprint v1.0

## 1. Purpose

This document defines the production database architecture and hardening blueprint for the Lottery/Keno platform before implementing final ticket acceptance, settlement, wallet enforcement, audit logging, anti-manipulation controls, integrity hashes, and signing.

This is a design blueprint only. It does not define executable migrations.

## 2. Architecture Principles

The production data model should enforce these principles at the database boundary:

- Critical financial records are append-only.
- Accepted tickets are immutable.
- Official results are immutable after posting.
- Corrections use explicit correction, reversal, or superseding records.
- Hierarchy moves require audit trails.
- Settlement is idempotent and versioned.
- Every sensitive admin action is auditable.
- Every major domain record has stable foreign keys.
- Integrity hashing is introduced before public/private signing.
- Signing is deferred until the schema is stable.

## 3. Accounts / Hierarchy

### Tables

- `accounts`
- `account_hierarchy_events`

### `accounts`

Purpose: stores all operational accounts in a single hierarchy.

Core fields:

- `id`
- `account_type`: `super_master`, `master_agent`, `agent`, `player`
- `parent_id`
- `username`
- `display_name`
- `email`
- `phone`
- `market_id`
- `language`
- `currency`
- `status`
- `cash_balance_snapshot`
- `credit_limit`
- `allocated_credit`
- `current_exposure`
- `max_bet`
- `max_payout`
- `notes`
- `created_at`
- `updated_at`

Hierarchy rules:

- `super_master` cannot have a parent.
- `super_master` may contain `master_agent` accounts.
- `master_agent` may have a parent of `super_master` or `master_agent`.
- `master_agent` may contain `master_agent` and `agent` accounts.
- `agent` must have a `master_agent` parent.
- `agent` may contain `player` accounts only.
- `player` must have an `agent` parent.
- `player` is terminal and cannot contain children.
- Circular hierarchy references must be blocked.

Uniqueness:

- `username` must be globally unique, case-insensitive.
- Username uniqueness is global across the platform, not scoped to agent, master, player, market, or operator.
- This prevents ambiguity across agent hierarchy navigation, PAM integrations, statements, audit logs, support workflows, and account recovery.

Downline visibility:

- `super_master` sees the entire network.
- `master_agent` sees descendants only.
- `agent` sees direct players only.
- `player` sees own account only.
- Backend queries must resolve downline access server-side. UI filtering is not sufficient.

### `account_hierarchy_events`

Purpose: immutable audit trail for hierarchy changes.

Core fields:

- `id`
- `account_id`
- `old_parent_id`
- `new_parent_id`
- `old_account_type`
- `new_account_type`
- `changed_by_admin_user_id`
- `reason_code`
- `reason_note`
- `created_at`

Rules:

- Insert only.
- Never update or delete hierarchy event records.
- Every parent reassignment must create a row.
- Production workflows should require reason codes for moving accounts with descendants.

## 4. Markets

### Tables

- `markets`

### `markets`

Purpose: lightweight localization and operating defaults. Markets are not regulatory/geofencing controls.

Core fields:

- `id`
- `name`
- `code`
- `language`
- `currency`
- `time_zone`
- `date_format`
- `number_format`
- `default_brand`
- `weekly_reset_day`
- `weekly_reset_time`
- `weekly_reset_time_zone`
- `active`
- `created_at`
- `updated_at`

Rules:

- `code` must be unique.
- `time_zone` and `weekly_reset_time_zone` must use IANA time zone names, for example `America/Costa_Rica`.
- Weekly reset fields drive future zero-balance processes.

## 5. Games / Drawings / Results

### Tables

- `games`
- `drawings`
- `drawing_results`
- `keno_draw_metrics`

### `games`

Purpose: product configuration for lottery and Keno-style games.

Core fields:

- `id`
- `market_id`
- `name`
- `code`
- `game_family`: `lottery`, `keno`
- `game_type`
- `status`
- lottery number model fields
- Keno number pool fields
- `draw_frequency_type`
- `draw_interval_seconds`
- `draw_id_prefix`
- `auto_generate_draws`
- `requires_paytable`
- `active_paytable_id`
- `created_at`
- `updated_at`

Keno recurring draw config:

- Keno games should use `draw_frequency_type = recurring`.
- `draw_interval_seconds` supports products such as 240-second Hot Spot or faster Keno variants.
- `draw_id_prefix` is used to generate draw codes such as `HS-20260608-0001`.
- Generated draw codes must be unique.

### `drawings`

Purpose: one row per draw instance.

Core fields:

- `id`
- `game_id`
- `draw_code`
- `draw_date`
- `draw_time`
- `draw_datetime`
- `cutoff_datetime`
- `status`
- `created_at`
- `updated_at`

Rules:

- `draw_code` must be unique.
- Tickets cannot be accepted after `cutoff_datetime`.
- Drawings with accepted tickets should not be deleted.
- Voids/cancellations should be status-driven and audited.

### `drawing_results`

Purpose: official result posting and correction workflow.

Core fields:

- `id`
- `drawing_id`
- `winning_numbers`
- `winning_bonus`
- `bullseye_number`
- `result_source`
- `source_reference`
- `status`: `posted`, `corrected`, `void`
- `posted_by_admin_user_id`
- `posted_at`
- `correction_of_result_id`
- `reason_code`
- `reason_note`
- `created_at`

Result immutability:

- Posted official results must not be updated in place.
- Corrections insert a new row linked by `correction_of_result_id`.
- The active result is the latest posted/corrected result according to workflow state.

### `keno_draw_metrics`

Purpose: reusable metrics derived from Keno results for multiple wager families.

Core fields:

- `id`
- `drawing_id`
- `winning_numbers`
- `draw_sum`
- `odd_count`
- `even_count`
- `low_count`
- `high_count`
- `first_half_count`
- `second_half_count`
- `dragon_digit`
- `tiger_digit`
- `dragon_tiger_result`
- `up_down_result`
- `element_result`
- `wood_count`
- `fire_count`
- `earth_count`
- `metal_count`
- `water_count`
- `bullseye_number`
- `created_at`

Rules:

- One metrics row per official active result version.
- Metrics should be regenerated only through result correction workflow.

## 6. Wagers / Pay Tables

### Tables

- `wager_types`
- `wager_options`
- `pay_tables`
- `pay_table_rows`

### `wager_types`

Purpose: defines wager categories.

Examples:

- Standard Spots
- Bullseye
- Dragon/Tiger
- Up/Down
- Odd/Even
- Big/Small
- Elements

Core fields:

- `id`
- `game_id`
- `name`
- `code`
- `settlement_method`
- `metric_key`
- `comparison_operator`
- `threshold_value`
- `active`
- `created_at`
- `updated_at`

### `wager_options`

Purpose: defines selectable outcomes beneath a wager type.

Examples:

- Dragon/Tiger: Dragon, Tiger, DT-Tie
- Up/Down: Up, Down, UD-Tie
- Odd/Even: Odd, Even
- Elements: Wood, Fire, Earth, Metal, Water

Core fields:

- `id`
- `wager_type_id`
- `name`
- `code`
- `active`
- `created_at`
- `updated_at`

Rules:

- `code` should be unique per `wager_type_id`.

### `pay_tables`

Purpose: game-specific payout schedule container.

Core fields:

- `id`
- `game_id`
- `wager_type_id`
- `name`
- `version`
- `effective_date`
- `expires_at`
- `active`
- `is_default`
- `created_at`
- `updated_at`

Rules:

- Paytables are not global.
- A game may have multiple paytables for standard, promotional, VIP, or future effective schedules.
- Only one active paytable may exist for the same game, wager type, and effective period.
- This prevents settlement ambiguity when grading ticket lines.

### `pay_table_rows`

Purpose: payout rules inside a paytable.

Core fields:

- `id`
- `pay_table_id`
- `spot_count`
- `hit_count`
- `bullseye_required`
- `wager_option_id`
- `payout_type`: `fixed`, `pari_mutuel`, `multiplier`
- `fixed_payout`
- `bullseye_fixed_payout`
- `maximum_payout`
- `created_at`

Versioning:

- Paytable rows should not be edited after effective use.
- Changes should create a new paytable version.

## 7. Tickets

### Tables

- `tickets`
- `ticket_lines`

### `tickets`

Purpose: accepted ticket header.

Core fields:

- `id`
- `ticket_number`
- `external_ticket_id`
- `account_id`
- `market_id`
- `game_id`
- `drawing_id`
- `funding_type`: `cash`, `credit`, `freeplay`
- `total_stake`
- `potential_payout`
- `currency`
- `status`: `pending`, `accepted`, `settled`, `void`, `cancelled`, `resettled`
- `accepted_at`
- `settled_at`
- `created_at`

Rules:

- `ticket_number` must be unique.
- Ticket acceptance must use a ticket idempotency key.
- The idempotency key must prevent duplicate accepted tickets caused by retries, double-clicks, network failures, PAM retries, or API replay.
- Accepted tickets are immutable.
- No edits after acceptance.
- Cancellation and voiding must occur through status events and audit logs.
- No late bets after drawing cutoff.
- The production idempotency key should be stored on the ticket record and enforced with a unique constraint.

### `ticket_lines`

Purpose: independently settled wager lines.

Core fields:

- `id`
- `ticket_id`
- `wager_type_id`
- `wager_option_id`
- `selected_numbers`
- `stake`
- `potential_payout`
- `status`
- `result_amount`
- `created_at`

Rules:

- One ticket can have multiple lines.
- Each line settles independently.
- Ticket-level status is derived from line outcomes and workflow state.

## 8. Financial Ledger

### Tables

- `ledger_transactions`

### `ledger_transactions`

Purpose: immutable financial ledger covering accounting, operational, and freeplay activity.

Core fields:

- `id`
- `account_id`
- `category`: `accounting`, `operational`, `freeplay`
- `transaction_type`
- `amount`
- `currency`
- `description`
- `reference_type`
- `reference_id`
- `parent_transaction_id`
- `created_by_admin_user_id`
- `created_at`

Transaction types:

- `deposit`
- `withdrawal`
- `zero_balance_credit`
- `zero_balance_debit`
- `transfer_in`
- `transfer_out`
- `manual_adjustment`
- `win`
- `loss`
- `credit_adjustment`
- `debit_adjustment`
- `freeplay_win`
- `freeplay_grant`
- `freeplay_wager`
- `freeplay_expiration`
- `freeplay_adjustment`
- `freeplay_reversal`
- `reversal`

Critical rules:

- Append-only.
- No update.
- No delete.
- Reversals only through new `reversal` transactions.
- `parent_transaction_id` links reversal transactions to originals.
- Weekly figure must be calculated from transactions, not stored as mutable balance.

## 9. Settlement

### Tables

- `settlement_runs`
- `settlement_records`

### `settlement_runs`

Purpose: one settlement execution context per drawing/version.

Core fields:

- `id`
- `drawing_id`
- `game_id`
- `status`: `pending`, `running`, `completed`, `failed`, `reversed`
- `started_at`
- `completed_at`
- `processed_ticket_count`
- `processed_line_count`
- `total_stake`
- `total_payout`
- `total_net`
- `created_by_admin_user_id`
- `override_authorization_id`
- `notes`
- `created_at`

Rules:

- Settlement is executed per drawing.
- Only one completed settlement run may exist per drawing unless a controlled resettlement override is authorized.
- This prevents duplicate settlement and duplicate ledger entries.
- Settlement must be idempotent.
- Failed runs should preserve records for audit.

### `settlement_records`

Purpose: per-ticket-line settlement outcome.

Core fields:

- `id`
- `settlement_run_id`
- `ticket_id`
- `ticket_line_id`
- `account_id`
- `game_id`
- `drawing_id`
- `wager_type_id`
- `wager_option_id`
- `stake`
- `payout`
- `net_amount`
- `outcome`: `win`, `loss`, `push`, `void`
- `status`: `pending`, `settled`, `reversed`, `failed`, `void`
- `version`
- `previous_settlement_record_id`
- `reversal_of_settlement_record_id`
- `ledger_transaction_id`
- `created_at`

Rules:

- Settlement records are append-friendly and versioned.
- Resettlement requires override authorization, reason code, approving admin, and audit entry.
- Reversal records must not delete original records.
- Ledger linkage must be explicit.

## 10. Audit

### Tables

- `audit_logs`

### `audit_logs`

Purpose: immutable record of sensitive actions and administrative changes.

Core fields:

- `id`
- `actor_admin_user_id`
- `action`
- `entity_type`
- `entity_id`
- `old_value`
- `new_value`
- `reason_code`
- `reason_note`
- `approval_id`
- `approved_by_admin_user_id`
- `ip_address`
- `device_id`
- `user_agent`
- `created_at`

Rules:

- Insert only.
- Sensitive actions must require reason codes.
- Approval metadata is required for resettlement, result correction, hierarchy moves, wallet adjustments, and overrides.

## 11. Admin Access

### Tables

- `admin_users`
- `admin_roles`
- `admin_permissions`
- `admin_user_roles`

### `admin_users`

Core fields:

- `id`
- `name`
- `email`
- `status`
- `created_at`
- `updated_at`

### `admin_roles`

Core fields:

- `id`
- `name`
- `description`
- `active`
- `created_at`
- `updated_at`

### `admin_permissions`

Core fields:

- `id`
- `permission_code`
- `description`
- `created_at`

### `admin_user_roles`

Core fields:

- `admin_user_id`
- `admin_role_id`
- `created_at`

Rules:

- Role-based access controls sensitive actions.
- Resettlement override requires explicit permission.
- Wallet adjustment requires explicit permission.
- Result correction requires explicit permission.
- Admin user management requires explicit permission.

## 12. Integrity & Security Fields

Reserved fields for critical tables:

- `record_hash`
- `previous_hash`
- `signature`
- `signature_key_id`
- `signature_version`
- `signed_at`

Critical tables:

- `tickets`
- `ticket_lines`
- `ledger_transactions`
- `drawing_results`
- `settlement_runs`
- `settlement_records`
- `audit_logs`
- `account_hierarchy_events`

Hardening sequence:

1. Add stable schema and constraints first.
2. Add deterministic record hashing.
3. Add hash chaining where sequence matters.
4. Add public/private signing later in Phase 4.8.

Signing should happen after schema stability because signatures must cover stable canonical payloads. Changing signed fields after deployment creates verification and replay complexity.

Hashing strategy:

- Ledger transactions use hash chaining.
- Settlement records use hash chaining.
- Official results use hash chaining.
- Tickets use individual record hashes at acceptance.

Reason:

- Ledger, settlement, and official result records are sequential tamper-sensitive records.
- Tickets are immutable once accepted and should be individually hashed at the acceptance boundary.
- Public/private signing remains Phase 4.8, near the end of pre-production hardening, because signing depends on stable final schemas and canonical payload formats.

## 13. Database Constraints

Required constraints:

- Unique case-insensitive `accounts.username`.
- Valid account hierarchy parent rules.
- No circular account hierarchy.
- Unique `markets.code`.
- Unique `games.code` per market/operator scope.
- Unique `drawings.draw_code`.
- Unique `tickets.ticket_number`.
- Unique ticket idempotency key.
- One active paytable for the same game, wager type, and effective period.
- One completed settlement per drawing.
- Foreign keys between all major records.
- No ticket edits after accepted.
- No ticket acceptance after cutoff.
- No result edits after official posting.
- No duplicate settlement.
- Ledger transactions append-only.
- No update/delete for ledger transactions.
- No update/delete for audit logs.
- No update/delete for hierarchy events.
- Resettlement requires override authorization.
- Financial corrections use reversal transactions.

Implementation notes:

- Append-only rules should be enforced with database permissions and triggers.
- Status transitions should be constrained by controlled functions or API workflows.
- Critical mutations should use stored procedures or transactional application services.

## 14. Indexes

Important indexes:

- `accounts(parent_id)`
- `accounts(lower(username))`
- `audit_logs(entity_type, entity_id)`
- `audit_logs(actor_admin_user_id, created_at)`
- `drawings(game_id, draw_datetime)`
- `drawings(draw_code)`
- `drawing_results(drawing_id, status)`
- `keno_draw_metrics(drawing_id)`
- `tickets(drawing_id)`
- `tickets(account_id, created_at)`
- `tickets(ticket_number)`
- `ticket_lines(ticket_id)`
- `ticket_lines(wager_type_id)`
- `ticket_lines(wager_option_id)`
- `ledger_transactions(account_id, created_at)`
- `ledger_transactions(reference_type, reference_id)`
- `settlement_runs(drawing_id, status)`
- `settlement_records(settlement_run_id)`
- `settlement_records(ticket_id)`
- `settlement_records(ticket_line_id)`
- `pay_tables(game_id, wager_type_id, active)`
- `pay_table_rows(pay_table_id, spot_count, hit_count)`

## 15. Future Phase 4.x Hardening Roadmap

### 4.1 Database Hardening

- Add foreign keys.
- Add check constraints.
- Add append-only triggers.
- Add controlled mutation functions for settlement, result correction, wallet adjustment, and hierarchy movement.

### 4.2 Security Hardening

- Enforce least privilege database roles.
- Restrict direct table writes for critical tables.
- Add row-level security where appropriate.
- Add secure secret management for service roles.

### 4.3 Authorization & Override Controls

- Implement permission checks for sensitive actions.
- Add override authorization records.
- Require reason codes and approver metadata for result correction, resettlement, wallet adjustment, and hierarchy moves.

### 4.4 Anti-Manipulation Controls

- Enforce cutoff at database/API boundary.
- Reject duplicate ticket submissions.
- Freeze accepted tickets.
- Freeze official results.
- Block direct result edits after official posting.
- Block duplicate settlement.
- Require controlled resettlement override authorization.
- Enforce financial corrections through reversal transactions.
- Block ledger update/delete.
- Track device/IP/user agent placeholders.
- Add anomaly reporting for voids, corrections, and resettlements.

### 4.5 Job/Worker Hardening

- Add job tables for draw generation, settlement execution, result import, and weekly reset.
- Add idempotency keys for jobs.
- Add retry counters and dead-letter states.
- Add worker audit records.

### 4.6 Infrastructure Hardening

- Separate service roles from admin roles.
- Use managed secrets.
- Add backup/restore procedures.
- Add monitoring for failed jobs and database exceptions.
- Add read replicas if reporting load grows.

### 4.7 Integrity Hashing

- Add canonical serialization for critical records.
- Add `record_hash`.
- Add `previous_hash` for ledger, audit, and settlement chains.
- Add verification jobs and reports.

### 4.8 Public/Private Signing

- Add signing keys after schema is stable.
- Sign critical record hashes, not mutable records.
- Store `signature`, `signature_key_id`, `signature_version`, and `signed_at`.
- Build verification tooling for audits and dispute resolution.

## 16. Locked Production Decisions

### Username Uniqueness Scope

Decision: usernames are globally unique across the platform.

Reason: global uniqueness prevents ambiguity across agents, masters, players, PAM integrations, statements, audit logs, support workflows, and account recovery.

### Ticket Idempotency Scope

Decision: ticket acceptance must use a ticket idempotency key enforced by the database.

Reason: idempotency prevents duplicate tickets from retries, double-clicks, network failures, PAM retries, or API replay.

Implementation note: the exact key composition may include external ticket id, source system, account, and organization context, but the production rule is that ticket acceptance must be uniquely idempotent.

### Settlement Execution Boundary

Decision: settlement is executed per drawing.

Only one completed settlement run may exist per drawing unless a controlled resettlement override is authorized.

Reason: this prevents duplicate settlement and duplicate ledger entries.

### Paytable Uniqueness

Decision: only one active paytable may exist for the same game, wager type, and effective period.

Reason: this prevents settlement ambiguity.

### Hash Chaining Strategy

Decision:

- Ledger transactions use hash chaining.
- Settlement records use hash chaining.
- Official results use hash chaining.
- Tickets use individual record hashes at acceptance.

Reason: ledger, settlement, and official results are sequential tamper-sensitive records. Tickets are immutable once accepted and should be individually hashed.

### Public/Private Signing

Decision: public/private signing remains Phase 4.8, near the end of pre-production hardening.

Reason: signing depends on stable final schemas and canonical payload formats.

### Reserved Integrity Fields

Decision: reserve these fields where applicable:

- `record_hash`
- `previous_hash`
- `signature`
- `signature_key_id`
- `signature_version`
- `signed_at`

### Anti-Manipulation Rules

Decision: production hardening must explicitly enforce these rules:

- No ticket edits after acceptance.
- No ticket acceptance after cutoff.
- No direct result edits after official posting.
- No duplicate settlement.
- No ledger update/delete.
- Resettlement requires override authorization.
- Financial corrections use reversal transactions.
