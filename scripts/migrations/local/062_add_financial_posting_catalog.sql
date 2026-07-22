create extension if not exists pgcrypto;

create table if not exists ledger_service.financial_posting_rules (
  rule_id text not null,
  rule_version text not null,
  instruction_type text not null,
  originating_authority text not null,
  required_account_roles text[] not null,
  debit_account_role text not null,
  credit_account_role text not null,
  amount_source text not null,
  currency_policy text not null,
  reversal_policy text not null,
  effective_date_policy text not null,
  lifecycle text not null,
  posting_enabled boolean not null,
  readiness_blocker text,
  effective_from timestamptz not null,
  effective_to timestamptz,
  content_hash text not null unique,
  created_at timestamptz not null default now(),
  primary key (rule_id, rule_version),
  constraint financial_posting_rules_lifecycle
    check (lifecycle in ('DRAFT', 'ACTIVE', 'RETIRED')),
  constraint financial_posting_rules_roles
    check (array_length(required_account_roles, 1) >= 2
      and debit_account_role = any(required_account_roles)
      and credit_account_role = any(required_account_roles)
      and debit_account_role <> credit_account_role),
  constraint financial_posting_rules_amount_source
    check (amount_source = 'AUTHORITATIVE_INSTRUCTION_AMOUNT'),
  constraint financial_posting_rules_currency_policy
    check (currency_policy = 'INSTRUCTION_CURRENCY'),
  constraint financial_posting_rules_reversal_policy
    check (reversal_policy in ('EXACT_COMPENSATING_JOURNAL', 'TERMINAL_NOOP')),
  constraint financial_posting_rules_effective_policy
    check (effective_date_policy = 'INSTRUCTION_EFFECTIVE_AT'),
  constraint financial_posting_rules_hash_format
    check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  constraint financial_posting_rules_enabled_state
    check (not posting_enabled or (lifecycle = 'ACTIVE' and readiness_blocker is null)),
  constraint financial_posting_rules_effective_period
    check (effective_to is null or effective_to > effective_from)
);

create unique index if not exists ux_financial_posting_rules_exact_resolution
  on ledger_service.financial_posting_rules (
    instruction_type, originating_authority, rule_version
  );
create index if not exists idx_financial_posting_rules_lifecycle
  on ledger_service.financial_posting_rules (lifecycle, posting_enabled);

drop trigger if exists financial_posting_rules_update_guard
  on ledger_service.financial_posting_rules;
create trigger financial_posting_rules_update_guard
before update on ledger_service.financial_posting_rules
for each row execute function ledger_service.prevent_ledger_evidence_update();

drop trigger if exists financial_posting_rules_delete_guard
  on ledger_service.financial_posting_rules;
create trigger financial_posting_rules_delete_guard
before delete on ledger_service.financial_posting_rules
for each row execute function ledger_service.prevent_ledger_evidence_delete();

with rules(
  rule_id, rule_version, instruction_type, originating_authority,
  debit_role, credit_role, reversal_policy, posting_enabled, blocker
) as (
  values
    ('LEGACY_MINIMAL_BALANCED_JOURNAL', '1.0.0', 'LEGACY_COMPATIBILITY', 'ledger-service',
      'OPERATOR_CLEARING', 'PLAYER_LIABILITY', 'EXACT_COMPENSATING_JOURNAL', true, null),
    ('SETTLEMENT_PAYOUT', '1.0.0', 'LEDGER_PAYOUT', 'settlement-service',
      'SETTLEMENT_CLEARING', 'PLAYER_LIABILITY', 'EXACT_COMPENSATING_JOURNAL', true, null),
    ('SETTLEMENT_REFUND', '1.0.0', 'LEDGER_REFUND', 'settlement-service',
      'SETTLEMENT_CLEARING', 'PLAYER_LIABILITY', 'EXACT_COMPENSATING_JOURNAL', true, null),
    ('AGENT_COMMISSION_ACCRUAL', '1.0.0', 'AGENT_COMMISSION_ACCRUAL', 'commission-authority',
      'AGENT_COMMISSION_EXPENSE_OR_GGR_ALLOCATION', 'AGENT_PAYABLE', 'EXACT_COMPENSATING_JOURNAL', true, null),
    ('AGENT_COMMISSION_PAYMENT', '1.0.0', 'AGENT_COMMISSION_PAYMENT', 'commission-authority',
      'AGENT_PAYABLE', 'OPERATOR_CLEARING', 'EXACT_COMPENSATING_JOURNAL', false,
      'Commission payment is deferred until an approved non-cashier payment path exists.'),
    ('PLAYER_REBATE_ACCRUAL', '1.0.0', 'PLAYER_REBATE_ACCRUAL', 'rebate-authority',
      'PLAYER_REBATE_EXPENSE', 'PLAYER_LIABILITY', 'EXACT_COMPENSATING_JOURNAL', true, null),
    ('PLAYER_REBATE_CREDIT', '1.0.0', 'PLAYER_REBATE_CREDIT', 'rebate-authority',
      'PLAYER_REBATE_EXPENSE', 'PLAYER_LIABILITY', 'EXACT_COMPENSATING_JOURNAL', true, null),
    ('PROMOTIONAL_CREDIT', '1.0.0', 'PROMOTIONAL_CREDIT', 'promotion-authority',
      'PROMOTION_EXPENSE', 'PLAYER_LIABILITY', 'EXACT_COMPENSATING_JOURNAL', true, null),
    ('MANUAL_CREDIT_ADJUSTMENT', '1.0.0', 'MANUAL_CREDIT_ADJUSTMENT', 'governance-authority',
      'MANUAL_ADJUSTMENT_CLEARING', 'PLAYER_LIABILITY', 'EXACT_COMPENSATING_JOURNAL', true, null),
    ('MANUAL_DEBIT_ADJUSTMENT', '1.0.0', 'MANUAL_DEBIT_ADJUSTMENT', 'governance-authority',
      'PLAYER_LIABILITY', 'MANUAL_ADJUSTMENT_CLEARING', 'EXACT_COMPENSATING_JOURNAL', true, null),
    ('WAGER_ACCEPTED_STAKE', '1.0.0', 'WAGER_ACCEPTED_STAKE', 'wager-authority',
      'PLAYER_LIABILITY', 'STAKE_REVENUE_CLEARING', 'EXACT_COMPENSATING_JOURNAL', false,
      'Accepted-wager authority evidence is not implemented; stake recognition cannot be inferred from settlement.'),
    ('FREE_PLAY_ISSUANCE', '1.0.0', 'FREE_PLAY_ISSUANCE', 'promotion-authority',
      'PROMOTION_EXPENSE', 'FREE_PLAY_LIABILITY', 'EXACT_COMPENSATING_JOURNAL', false,
      'Free-play issuance policy is not approved for the current wallet contract.'),
    ('FREE_PLAY_CONVERSION', '1.0.0', 'FREE_PLAY_CONVERSION', 'settlement-service',
      'FREE_PLAY_LIABILITY', 'PLAYER_LIABILITY', 'EXACT_COMPENSATING_JOURNAL', false,
      'Free-play conversion policy is not approved for the current wallet contract.'),
    ('CASHIER_DEPOSIT', '1.0.0', 'CASHIER_DEPOSIT', 'cashier-service',
      'OPERATOR_CLEARING', 'PLAYER_LIABILITY', 'EXACT_COMPENSATING_JOURNAL', false,
      'Cashier deposits are intentionally deferred for credit-only launch.'),
    ('CASHIER_WITHDRAWAL', '1.0.0', 'CASHIER_WITHDRAWAL', 'cashier-service',
      'PLAYER_LIABILITY', 'OPERATOR_CLEARING', 'EXACT_COMPENSATING_JOURNAL', false,
      'Cashier withdrawals are intentionally deferred for credit-only launch.')
)
insert into ledger_service.financial_posting_rules (
  rule_id, rule_version, instruction_type, originating_authority,
  required_account_roles, debit_account_role, credit_account_role,
  amount_source, currency_policy, reversal_policy, effective_date_policy,
  lifecycle, posting_enabled, readiness_blocker, effective_from, content_hash
)
select rule_id, rule_version, instruction_type, originating_authority,
       array[debit_role, credit_role], debit_role, credit_role,
       'AUTHORITATIVE_INSTRUCTION_AMOUNT', 'INSTRUCTION_CURRENCY', reversal_policy,
       'INSTRUCTION_EFFECTIVE_AT', 'ACTIVE', posting_enabled, blocker,
       '2026-01-01T00:00:00Z'::timestamptz,
       'sha256:' || encode(digest(concat_ws('|', rule_id, rule_version, instruction_type,
         originating_authority, debit_role, credit_role, reversal_policy,
         posting_enabled::text, coalesce(blocker, '')), 'sha256'), 'hex')
from rules
on conflict (rule_id, rule_version) do nothing;

alter table ledger_service.ledger_entries
  drop constraint if exists ledger_entries_account_class_supported;
alter table ledger_service.ledger_entries
  add constraint ledger_entries_account_class_supported check (account_class in (
    'PLAYER_LIABILITY', 'SETTLEMENT_CLEARING', 'OPERATOR_CLEARING',
    'STAKE_REVENUE_CLEARING', 'AGENT_PAYABLE',
    'AGENT_COMMISSION_EXPENSE_OR_GGR_ALLOCATION', 'PLAYER_REBATE_EXPENSE',
    'PROMOTION_EXPENSE', 'FREE_PLAY_LIABILITY', 'MANUAL_ADJUSTMENT_CLEARING'
  ));

alter table ledger_service.ledger_transactions
  add column if not exists posting_rule_id text,
  add column if not exists posting_rule_version text;

drop trigger if exists ledger_transactions_update_guard
  on ledger_service.ledger_transactions;

update ledger_service.ledger_transactions
set posting_rule_id = 'LEGACY_MINIMAL_BALANCED_JOURNAL',
    posting_rule_version = '1.0.0'
where posting_rule_id is null or posting_rule_version is null;

create trigger ledger_transactions_update_guard
before update on ledger_service.ledger_transactions
for each row execute function ledger_service.prevent_ledger_evidence_update();

alter table ledger_service.ledger_transactions
  alter column posting_rule_id set not null,
  alter column posting_rule_version set not null,
  add constraint ledger_transactions_posting_rule_fk
    foreign key (posting_rule_id, posting_rule_version)
    references ledger_service.financial_posting_rules(rule_id, rule_version);

create index if not exists idx_ledger_transactions_posting_rule
  on ledger_service.ledger_transactions (posting_rule_id, posting_rule_version);
