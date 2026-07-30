create extension if not exists pgcrypto;
create schema if not exists compensation;

create or replace function compensation.prevent_immutable_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'Compensation evidence is append-only.';
end;
$$;

create table compensation.configurations (
  id uuid primary key default gen_random_uuid(),
  hierarchy_owner_account_id uuid not null references public.accounts(id),
  beneficiary_account_id uuid not null references public.accounts(id),
  strategy text not null check (strategy in ('COMMISSION', 'REBATE')),
  calculation_basis text not null check (calculation_basis = 'NET_LOSS'),
  rate_basis_points integer not null check (rate_basis_points between 0 and 10000),
  accounting_period text not null check (accounting_period = 'WEEKLY'),
  minimum_threshold_minor bigint not null default 0 check (minimum_threshold_minor >= 0),
  maximum_compensation_minor bigint check (maximum_compensation_minor >= 0),
  funding_instrument text not null check (funding_instrument = 'CREDIT'),
  effective_from timestamptz not null,
  effective_to timestamptz,
  enabled boolean not null default true,
  source_configuration_reference text,
  idempotency_key text not null unique,
  canonical_request_hash text not null check (canonical_request_hash ~ '^sha256:[0-9a-f]{64}$'),
  content_hash text not null unique check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  check (maximum_compensation_minor is null
    or maximum_compensation_minor >= minimum_threshold_minor)
);

create index idx_compensation_configuration_owner
  on compensation.configurations(hierarchy_owner_account_id, strategy, enabled);
create index idx_compensation_configuration_beneficiary
  on compensation.configurations(beneficiary_account_id, strategy, enabled);
create index idx_compensation_configuration_effective
  on compensation.configurations(effective_from, effective_to);

create table compensation.executions (
  id uuid primary key default gen_random_uuid(),
  accounting_period_id uuid not null
    references ledger_service.weekly_accounting_periods(period_id),
  idempotency_key text not null unique,
  canonical_request_hash text not null check (canonical_request_hash ~ '^sha256:[0-9a-f]{64}$'),
  correlation_id text not null,
  created_at timestamptz not null default now()
);

create index idx_compensation_executions_period
  on compensation.executions(accounting_period_id, created_at);

create table compensation.entitlements (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references compensation.executions(id),
  configuration_id uuid not null references compensation.configurations(id),
  accounting_period_id uuid not null
    references ledger_service.weekly_accounting_periods(period_id),
  hierarchy_owner_account_id uuid not null references public.accounts(id),
  beneficiary_account_id uuid not null references public.accounts(id),
  strategy text not null check (strategy in ('COMMISSION', 'REBATE')),
  reporting_classification text not null
    check (reporting_classification in ('COMMISSION', 'REBATE')),
  calculation_basis text not null check (calculation_basis = 'NET_LOSS'),
  basis_amount_minor bigint not null check (basis_amount_minor >= 0),
  rate_basis_points integer not null check (rate_basis_points between 0 and 10000),
  compensation_amount_minor bigint not null check (compensation_amount_minor > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  funding_instrument text not null check (funding_instrument = 'CREDIT'),
  wallet_id uuid not null references public.financial_wallets(id),
  ledger_transaction_type text not null check (
    (strategy = 'COMMISSION'
      and reporting_classification = 'COMMISSION'
      and ledger_transaction_type = 'AGENT_COMMISSION_ACCRUAL')
    or
    (strategy = 'REBATE'
      and reporting_classification = 'REBATE'
      and ledger_transaction_type = 'PLAYER_REBATE_CREDIT')
  ),
  canonical_entitlement_hash text not null unique
    check (canonical_entitlement_hash ~ '^sha256:[0-9a-f]{64}$'),
  reversal_of_entitlement_id uuid references compensation.entitlements(id),
  created_at timestamptz not null default now(),
  check (reversal_of_entitlement_id is null or reversal_of_entitlement_id <> id)
);

create unique index ux_compensation_entitlement_period
  on compensation.entitlements(configuration_id, accounting_period_id)
  where reversal_of_entitlement_id is null;
create unique index ux_compensation_entitlement_reversal
  on compensation.entitlements(reversal_of_entitlement_id)
  where reversal_of_entitlement_id is not null;
create index idx_compensation_entitlement_beneficiary
  on compensation.entitlements(beneficiary_account_id, accounting_period_id);
create index idx_compensation_entitlement_reporting
  on compensation.entitlements(reporting_classification, accounting_period_id);

create table compensation.events (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references compensation.executions(id),
  entitlement_id uuid references compensation.entitlements(id),
  event_type text not null check (
    event_type in ('CALCULATED', 'POSTED', 'REVERSED', 'FAILED', 'COMPLETED')
  ),
  ledger_entry_id uuid references public.financial_ledger_entries(id),
  canonical_evidence_hash text not null unique
    check (canonical_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (
    (event_type in ('POSTED', 'REVERSED') and ledger_entry_id is not null)
    or (event_type not in ('POSTED', 'REVERSED') and ledger_entry_id is null)
  )
);

create index idx_compensation_events_execution
  on compensation.events(execution_id, created_at, id);
create index idx_compensation_events_entitlement
  on compensation.events(entitlement_id, created_at, id);

create view compensation.reporting_entitlements as
select
  entitlement.id,
  entitlement.accounting_period_id,
  entitlement.hierarchy_owner_account_id,
  entitlement.beneficiary_account_id,
  entitlement.reporting_classification,
  entitlement.basis_amount_minor,
  entitlement.compensation_amount_minor,
  entitlement.currency,
  entitlement.created_at
from compensation.entitlements entitlement;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'configurations', 'executions', 'entitlements', 'events'
  ] loop
    execute format(
      'create trigger %I before update or delete on compensation.%I
       for each row execute function compensation.prevent_immutable_mutation()',
      'trg_compensation_' || table_name || '_immutable',
      table_name
    );
  end loop;
end;
$$;

comment on schema compensation is
  'Canonical immutable Compensation Authority for Commission and Rebate.';
comment on table compensation.entitlements is
  'Immutable Commission or Rebate entitlement derived only from authoritative settled activity.';
comment on view compensation.reporting_entitlements is
  'Separate Commission and Rebate reporting classifications; consumers must not merge them.';
