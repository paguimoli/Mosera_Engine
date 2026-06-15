create table if not exists public.commission_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text null,
  calculation_basis text not null,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commission_plans_calculation_basis_check check (
    calculation_basis in ('NET_LOSS', 'TURNOVER', 'HYBRID')
  ),
  constraint commission_plans_status_check check (
    status in ('ACTIVE', 'DISABLED')
  )
);

create index if not exists commission_plans_code_idx
  on public.commission_plans (code);

create index if not exists commission_plans_calculation_basis_idx
  on public.commission_plans (calculation_basis);

create index if not exists commission_plans_status_idx
  on public.commission_plans (status);

drop trigger if exists set_commission_plans_updated_at on public.commission_plans;
create trigger set_commission_plans_updated_at
  before update on public.commission_plans
  for each row
  execute function public.set_updated_at();

alter table public.commission_plans enable row level security;

create table if not exists public.commission_plan_rules (
  id uuid primary key default gen_random_uuid(),
  commission_plan_id uuid not null references public.commission_plans(id) on delete cascade,
  rule_type text not null,
  rate numeric(9, 4) not null,
  applies_to_account_type text null,
  min_amount numeric(18, 4) null,
  max_amount numeric(18, 4) null,
  created_at timestamptz not null default now(),
  constraint commission_plan_rules_rule_type_check check (
    rule_type in ('NET_LOSS_PERCENT', 'TURNOVER_PERCENT', 'FLAT_AMOUNT')
  ),
  constraint commission_plan_rules_rate_check check (rate >= 0),
  constraint commission_plan_rules_applies_to_account_type_check check (
    applies_to_account_type is null
    or applies_to_account_type in ('MASTER_AGENT', 'AGENT', 'PLAYER')
  )
);

create index if not exists commission_plan_rules_commission_plan_id_idx
  on public.commission_plan_rules (commission_plan_id);

create index if not exists commission_plan_rules_rule_type_idx
  on public.commission_plan_rules (rule_type);

create index if not exists commission_plan_rules_applies_to_account_type_idx
  on public.commission_plan_rules (applies_to_account_type);

alter table public.commission_plan_rules enable row level security;

create table if not exists public.account_commission_assignments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  commission_plan_id uuid not null references public.commission_plans(id),
  status text not null,
  effective_from timestamptz not null default now(),
  effective_to timestamptz null,
  created_at timestamptz not null default now(),
  constraint account_commission_assignments_status_check check (
    status in ('ACTIVE', 'INACTIVE')
  ),
  constraint account_commission_assignments_unique unique (
    account_id,
    commission_plan_id,
    effective_from
  )
);

create index if not exists account_commission_assignments_account_id_idx
  on public.account_commission_assignments (account_id);

create index if not exists account_commission_assignments_commission_plan_id_idx
  on public.account_commission_assignments (commission_plan_id);

create index if not exists account_commission_assignments_status_idx
  on public.account_commission_assignments (status);

create index if not exists account_commission_assignments_effective_from_idx
  on public.account_commission_assignments (effective_from);

create index if not exists account_commission_assignments_effective_to_idx
  on public.account_commission_assignments (effective_to);

alter table public.account_commission_assignments enable row level security;

create table if not exists public.weekly_commission_records (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.weekly_accounting_periods(id),
  account_id uuid not null references public.accounts(id),
  commission_plan_id uuid not null references public.commission_plans(id),
  calculation_basis text not null,
  gross_basis_amount numeric(18, 4) not null default 0,
  commission_amount numeric(18, 4) not null default 0,
  status text not null,
  created_at timestamptz not null default now(),
  approved_at timestamptz null,
  paid_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  constraint weekly_commission_records_calculation_basis_check check (
    calculation_basis in ('NET_LOSS', 'TURNOVER', 'HYBRID')
  ),
  constraint weekly_commission_records_status_check check (
    status in ('DRAFT', 'APPROVED', 'PAID', 'VOID')
  ),
  constraint weekly_commission_records_unique unique (
    period_id,
    account_id,
    commission_plan_id
  )
);

create index if not exists weekly_commission_records_period_id_idx
  on public.weekly_commission_records (period_id);

create index if not exists weekly_commission_records_account_id_idx
  on public.weekly_commission_records (account_id);

create index if not exists weekly_commission_records_commission_plan_id_idx
  on public.weekly_commission_records (commission_plan_id);

create index if not exists weekly_commission_records_status_idx
  on public.weekly_commission_records (status);

alter table public.weekly_commission_records enable row level security;
