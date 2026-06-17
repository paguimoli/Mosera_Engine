alter table public.commission_plans
  add column if not exists account_id uuid null references public.accounts(id),
  add column if not exists account_type text null,
  add column if not exists commission_type text null,
  add column if not exists percentage_basis_points integer not null default 0,
  add column if not exists active boolean not null default true;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'commission_plans_account_type_engine_check'
  ) then
    alter table public.commission_plans
      add constraint commission_plans_account_type_engine_check
      check (
        account_type is null or
        account_type in ('SUPER_MASTER', 'MASTER_AGENT', 'AGENT', 'PLAYER')
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'commission_plans_commission_type_engine_check'
  ) then
    alter table public.commission_plans
      add constraint commission_plans_commission_type_engine_check
      check (
        commission_type is null or
        commission_type in ('LOSS_BASED_PERCENTAGE')
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'commission_plans_percentage_basis_points_check'
  ) then
    alter table public.commission_plans
      add constraint commission_plans_percentage_basis_points_check
      check (percentage_basis_points >= 0 and percentage_basis_points <= 10000);
  end if;
end $$;

create index if not exists commission_plans_account_id_engine_idx
  on public.commission_plans(account_id);

create index if not exists commission_plans_active_engine_idx
  on public.commission_plans(active);

create table if not exists public.commission_runs (
  id uuid primary key default gen_random_uuid(),
  week_start timestamptz not null,
  week_end timestamptz not null,
  currency text not null,
  status text not null,
  correlation_id text null,
  created_at timestamptz not null default now(),
  completed_at timestamptz null,
  constraint commission_runs_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint commission_runs_status_check check (
    status in ('STARTED', 'COMPLETED', 'FAILED', 'REVERSED')
  ),
  constraint commission_runs_window_check check (week_end > week_start),
  constraint commission_runs_week_currency_unique unique (
    week_start,
    week_end,
    currency
  )
);

create index if not exists commission_runs_week_start_idx
  on public.commission_runs(week_start);

create index if not exists commission_runs_week_end_idx
  on public.commission_runs(week_end);

create index if not exists commission_runs_status_idx
  on public.commission_runs(status);

create index if not exists commission_runs_correlation_id_idx
  on public.commission_runs(correlation_id);

alter table public.commission_runs enable row level security;

create table if not exists public.commission_run_details (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.commission_runs(id) on delete cascade,
  account_id uuid not null references public.accounts(id),
  snapshot_id uuid not null references public.weekly_accounting_snapshots(id),
  net_result bigint not null,
  commission_percentage_basis_points integer not null,
  commission_amount bigint not null,
  created_at timestamptz not null default now(),
  constraint commission_run_details_percentage_check check (
    commission_percentage_basis_points >= 0 and
    commission_percentage_basis_points <= 10000
  ),
  constraint commission_run_details_amount_check check (commission_amount >= 0),
  constraint commission_run_details_unique unique (run_id, account_id, snapshot_id)
);

create index if not exists commission_run_details_run_id_idx
  on public.commission_run_details(run_id);

create index if not exists commission_run_details_account_id_idx
  on public.commission_run_details(account_id);

create index if not exists commission_run_details_snapshot_id_idx
  on public.commission_run_details(snapshot_id);

alter table public.commission_run_details enable row level security;

create table if not exists public.commission_adjustments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  run_id uuid not null references public.commission_runs(id),
  adjustment_amount bigint not null,
  reason_code text not null,
  notes text null,
  actor_user_id uuid null,
  correlation_id text null,
  created_at timestamptz not null default now(),
  constraint commission_adjustments_reason_code_check check (btrim(reason_code) <> '')
);

create index if not exists commission_adjustments_account_id_idx
  on public.commission_adjustments(account_id);

create index if not exists commission_adjustments_run_id_idx
  on public.commission_adjustments(run_id);

create index if not exists commission_adjustments_created_at_idx
  on public.commission_adjustments(created_at);

alter table public.commission_adjustments enable row level security;

create or replace function public.generate_commission_run_from_snapshots(
  p_week_start timestamptz,
  p_week_end timestamptz,
  p_currency text,
  p_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.commission_runs%rowtype;
  v_detail_count integer := 0;
  v_inserted_detail_count integer := 0;
  v_total_commission bigint := 0;
begin
  if p_week_start is null or p_week_end is null or p_week_end <= p_week_start then
    raise exception 'Commission run window is invalid.';
  end if;

  if p_currency is null or btrim(p_currency) !~ '^[A-Z]{3}$' then
    raise exception 'Commission run currency is invalid.';
  end if;

  insert into public.commission_runs (
    week_start,
    week_end,
    currency,
    status,
    correlation_id
  )
  values (
    p_week_start,
    p_week_end,
    btrim(p_currency),
    'STARTED',
    p_correlation_id
  )
  on conflict (week_start, week_end, currency)
  do update set correlation_id = coalesce(public.commission_runs.correlation_id, excluded.correlation_id)
  returning *
    into v_run;

  with effective_plans as (
    select distinct on (account_id)
      account_id,
      commission_plan_id
    from public.account_commission_assignments
    where status = 'ACTIVE'
      and effective_from <= p_week_end
      and (effective_to is null or effective_to >= p_week_start)
    order by account_id, effective_from desc
  ),
  eligible as (
    select
      s.id as snapshot_id,
      s.account_id,
      s.net_result,
      coalesce(cp.percentage_basis_points, (r.rate * 100)::integer, 0) as basis_points
    from public.weekly_accounting_snapshots s
    join public.accounts a on a.id = s.account_id
    left join effective_plans ep on ep.account_id = s.account_id
    left join public.commission_plans cp on cp.id = coalesce(ep.commission_plan_id, (
      select cp2.id
      from public.commission_plans cp2
      where cp2.account_id = s.account_id
        and cp2.active = true
        and cp2.status = 'ACTIVE'
      order by cp2.created_at desc
      limit 1
    ))
    left join lateral (
      select rule.rate
      from public.commission_plan_rules rule
      where rule.commission_plan_id = cp.id
        and rule.rule_type = 'NET_LOSS_PERCENT'
      order by rule.created_at desc
      limit 1
    ) r on true
    where s.week_start = p_week_start
      and s.week_end = p_week_end
      and s.currency = btrim(p_currency)
      and s.account_type in ('SUPER_MASTER', 'MASTER_AGENT', 'AGENT')
      and coalesce(cp.commission_type, 'LOSS_BASED_PERCENTAGE') = 'LOSS_BASED_PERCENTAGE'
      and cp.status = 'ACTIVE'
      and coalesce(cp.active, true) = true
  ),
  inserted as (
    insert into public.commission_run_details (
      run_id,
      account_id,
      snapshot_id,
      net_result,
      commission_percentage_basis_points,
      commission_amount
    )
    select
      v_run.id,
      eligible.account_id,
      eligible.snapshot_id,
      eligible.net_result,
      eligible.basis_points,
      case
        when eligible.net_result < 0 then
          ((abs(eligible.net_result) * eligible.basis_points) / 10000)::bigint
        else 0
      end
    from eligible
    where eligible.basis_points > 0
    on conflict (run_id, account_id, snapshot_id) do nothing
    returning id
  )
  select count(*) into v_inserted_detail_count
  from inserted;

  select count(*), coalesce(sum(commission_amount), 0)::bigint
    into v_detail_count, v_total_commission
  from public.commission_run_details
  where run_id = v_run.id;

  update public.commission_runs
    set status = 'COMPLETED',
        completed_at = coalesce(completed_at, now())
  where id = v_run.id
  returning *
    into v_run;

  if v_inserted_detail_count > 0 then
    insert into public.outbox_events (
      event_type,
      aggregate_type,
      aggregate_id,
      payload,
      status,
      correlation_id
    )
    values (
      'commission.run.completed',
      'commission_run',
      v_run.id::text,
      jsonb_build_object(
        'runId', v_run.id,
        'weekStart', v_run.week_start,
        'weekEnd', v_run.week_end,
        'currency', v_run.currency,
        'detailCount', v_detail_count,
        'totalCommission', v_total_commission
      ),
      'PENDING',
      p_correlation_id
    )
    on conflict do nothing;
  end if;

  return jsonb_build_object(
    'runId', v_run.id,
    'weekStart', v_run.week_start,
    'weekEnd', v_run.week_end,
    'currency', v_run.currency,
    'status', v_run.status,
    'correlationId', v_run.correlation_id,
    'createdAt', v_run.created_at,
    'completedAt', v_run.completed_at,
    'detailCount', v_detail_count,
    'totalCommission', v_total_commission
  );
end;
$$;

create or replace function public.create_commission_adjustment(
  p_account_id uuid,
  p_run_id uuid,
  p_adjustment_amount bigint,
  p_reason_code text,
  p_notes text default null,
  p_actor_user_id uuid default null,
  p_correlation_id text default null
)
returns public.commission_adjustments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_adjustment public.commission_adjustments%rowtype;
begin
  if p_adjustment_amount is null or p_adjustment_amount = 0 then
    raise exception 'Commission adjustment amount is required.';
  end if;

  if p_reason_code is null or btrim(p_reason_code) = '' then
    raise exception 'Commission adjustment reason code is required.';
  end if;

  insert into public.commission_adjustments (
    account_id,
    run_id,
    adjustment_amount,
    reason_code,
    notes,
    actor_user_id,
    correlation_id
  )
  values (
    p_account_id,
    p_run_id,
    p_adjustment_amount,
    btrim(p_reason_code),
    p_notes,
    p_actor_user_id,
    p_correlation_id
  )
  returning *
    into v_adjustment;

  insert into public.outbox_events (
    event_type,
    aggregate_type,
    aggregate_id,
    payload,
    status,
    correlation_id
  )
  values (
    'commission.adjustment.created',
    'commission_adjustment',
    v_adjustment.id::text,
    jsonb_build_object(
      'adjustmentId', v_adjustment.id,
      'accountId', v_adjustment.account_id,
      'runId', v_adjustment.run_id,
      'adjustmentAmount', v_adjustment.adjustment_amount,
      'reasonCode', v_adjustment.reason_code,
      'actorUserId', v_adjustment.actor_user_id
    ),
    'PENDING',
    p_correlation_id
  );

  return v_adjustment;
end;
$$;
