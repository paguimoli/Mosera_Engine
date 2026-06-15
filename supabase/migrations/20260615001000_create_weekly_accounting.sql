create table if not exists public.weekly_accounting_periods (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.markets(id),
  brand_id uuid not null references public.brands(id),
  period_start_at timestamptz not null,
  period_end_at timestamptz not null,
  status text not null,
  created_at timestamptz not null default now(),
  closed_at timestamptz null,
  constraint weekly_accounting_periods_status_check check (
    status in ('OPEN', 'CLOSED')
  ),
  constraint weekly_accounting_periods_market_brand_window_unique unique (
    market_id,
    brand_id,
    period_start_at,
    period_end_at
  )
);

create index if not exists weekly_accounting_periods_market_id_idx
  on public.weekly_accounting_periods (market_id);

create index if not exists weekly_accounting_periods_brand_id_idx
  on public.weekly_accounting_periods (brand_id);

create index if not exists weekly_accounting_periods_status_idx
  on public.weekly_accounting_periods (status);

create index if not exists weekly_accounting_periods_period_start_at_idx
  on public.weekly_accounting_periods (period_start_at);

create index if not exists weekly_accounting_periods_period_end_at_idx
  on public.weekly_accounting_periods (period_end_at);

alter table public.weekly_accounting_periods enable row level security;

create table if not exists public.weekly_account_summaries (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.weekly_accounting_periods(id) on delete cascade,
  account_id uuid not null references public.accounts(id),
  account_type text not null,
  parent_account_id uuid null references public.accounts(id),
  funding_model text null,
  operating_mode text null,
  weekly_accounting_mode text null,
  settlement_mode text null,
  opening_balance numeric(18, 4) not null default 0,
  closing_balance numeric(18, 4) not null default 0,
  settled_result_amount numeric(18, 4) not null default 0,
  pending_exposure_amount numeric(18, 4) not null default 0,
  ticket_count integer not null default 0,
  settled_ticket_count integer not null default 0,
  pending_ticket_count integer not null default 0,
  active_this_week boolean not null default false,
  has_carry_balance boolean not null default false,
  has_pending_exposure boolean not null default false,
  zero_balance_entry_id uuid null references public.financial_ledger_entries(id),
  status text not null,
  created_at timestamptz not null default now(),
  closed_at timestamptz null,
  constraint weekly_account_summaries_status_check check (
    status in ('OPEN', 'CLOSED')
  ),
  constraint weekly_account_summaries_period_account_unique unique (
    period_id,
    account_id
  )
);

create index if not exists weekly_account_summaries_period_id_idx
  on public.weekly_account_summaries (period_id);

create index if not exists weekly_account_summaries_account_id_idx
  on public.weekly_account_summaries (account_id);

create index if not exists weekly_account_summaries_account_type_idx
  on public.weekly_account_summaries (account_type);

create index if not exists weekly_account_summaries_parent_account_id_idx
  on public.weekly_account_summaries (parent_account_id);

create index if not exists weekly_account_summaries_active_this_week_idx
  on public.weekly_account_summaries (active_this_week);

create index if not exists weekly_account_summaries_has_carry_balance_idx
  on public.weekly_account_summaries (has_carry_balance);

create index if not exists weekly_account_summaries_has_pending_exposure_idx
  on public.weekly_account_summaries (has_pending_exposure);

create index if not exists weekly_account_summaries_status_idx
  on public.weekly_account_summaries (status);

alter table public.weekly_account_summaries enable row level security;
