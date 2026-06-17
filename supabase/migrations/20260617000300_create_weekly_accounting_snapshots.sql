create table if not exists public.weekly_accounting_snapshots (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  account_type text not null,
  week_start timestamptz not null,
  week_end timestamptz not null,
  currency text not null,
  opening_balance bigint not null default 0,
  closing_balance bigint not null default 0,
  settled_wins bigint not null default 0,
  settled_losses bigint not null default 0,
  net_result bigint not null default 0,
  ticket_count integer not null default 0,
  pending_exposure bigint not null default 0,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint weekly_accounting_snapshots_account_type_check check (
    account_type in ('SUPER_MASTER', 'MASTER_AGENT', 'AGENT', 'PLAYER')
  ),
  constraint weekly_accounting_snapshots_currency_check check (
    currency ~ '^[A-Z]{3}$'
  ),
  constraint weekly_accounting_snapshots_window_check check (
    week_end > week_start
  ),
  constraint weekly_accounting_snapshots_money_check check (
    settled_wins >= 0 and settled_losses >= 0 and ticket_count >= 0 and
    pending_exposure >= 0
  ),
  constraint weekly_accounting_snapshots_account_week_currency_unique unique (
    account_id,
    week_start,
    week_end,
    currency
  )
);

create index if not exists weekly_accounting_snapshots_account_id_idx
  on public.weekly_accounting_snapshots(account_id);

create index if not exists weekly_accounting_snapshots_week_start_idx
  on public.weekly_accounting_snapshots(week_start);

create index if not exists weekly_accounting_snapshots_week_end_idx
  on public.weekly_accounting_snapshots(week_end);

alter table public.weekly_accounting_snapshots enable row level security;

create or replace function public.generate_weekly_accounting_snapshots(
  p_week_start timestamptz,
  p_week_end timestamptz,
  p_account_scope uuid default null,
  p_currency text default 'USD',
  p_close_mode text default null,
  p_correlation_id text default null
)
returns setof public.weekly_accounting_snapshots
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_zero_entry public.financial_ledger_entries%rowtype;
  v_inserted_count integer := 0;
begin
  if p_week_start is null or p_week_end is null or p_week_end <= p_week_start then
    raise exception 'Weekly accounting window is invalid.';
  end if;

  if p_currency is null or btrim(p_currency) !~ '^[A-Z]{3}$' then
    raise exception 'Weekly accounting currency is invalid.';
  end if;

  if p_close_mode is not null and p_close_mode not in ('CARRY_BALANCE', 'ZERO_BALANCE') then
    raise exception 'Weekly accounting close mode is invalid.';
  end if;

  drop table if exists weekly_accounting_calculation;
  drop table if exists weekly_accounting_inserted_snapshots;

  create temp table weekly_accounting_calculation on commit drop as
  with recursive scoped_accounts as (
    select a.*
    from public.accounts a
    where p_account_scope is null or a.id = p_account_scope

    union all

    select child.*
    from public.accounts child
    join scoped_accounts parent on child.parent_account_id = parent.id
    where p_account_scope is not null
  ),
  account_descendants as (
    select root.id as root_id, root.id as descendant_id
    from scoped_accounts root

    union all

    select account_descendants.root_id, child.id
    from account_descendants
    join public.accounts child on child.parent_account_id = account_descendants.descendant_id
  ),
  direct_activity as (
    select
      c.player_id as account_id,
      coalesce(sum(case when c.balance_impact > 0 then c.balance_impact else 0 end), 0)::bigint as settled_wins,
      coalesce(sum(case when c.balance_impact < 0 then abs(c.balance_impact) else 0 end), 0)::bigint as settled_losses,
      coalesce(sum(c.balance_impact), 0)::bigint as net_result,
      count(distinct c.ticket_id)::integer as ticket_count
    from public.credit_settlement_applications c
    where c.created_at >= p_week_start
      and c.created_at < p_week_end
      and c.currency = btrim(p_currency)
    group by c.player_id
  ),
  direct_pending as (
    select
      r.player_id as account_id,
      coalesce(sum(r.remaining_exposure), 0)::bigint as pending_exposure
    from public.credit_reservations r
    where r.status in ('RESERVED', 'PARTIALLY_RELEASED')
      and r.currency = btrim(p_currency)
    group by r.player_id
  ),
  direct_wallets as (
    select
      w.account_id,
      w.id as wallet_id,
      coalesce(w.balance, 0)::bigint as current_balance
    from public.financial_wallets w
    where w.wallet_type = 'CREDIT'
      and w.currency_code = btrim(p_currency)
  ),
  player_figures as (
    select
      player.id as account_id,
      dw.wallet_id,
      coalesce(da.settled_wins, 0)::bigint as settled_wins,
      coalesce(da.settled_losses, 0)::bigint as settled_losses,
      coalesce(da.net_result, 0)::bigint as net_result,
      coalesce(da.ticket_count, 0)::integer as ticket_count,
      coalesce(dp.pending_exposure, 0)::bigint as pending_exposure,
      coalesce(dw.current_balance, 0)::bigint as current_balance,
      (coalesce(dw.current_balance, 0)::bigint - coalesce(da.net_result, 0)::bigint) as opening_balance,
      coalesce(p_close_mode, player.weekly_accounting_mode, 'CARRY_BALANCE') as close_mode
    from public.accounts player
    left join direct_activity da on da.account_id = player.id
    left join direct_pending dp on dp.account_id = player.id
    left join direct_wallets dw on dw.account_id = player.id
    where player.account_type = 'PLAYER'
  ),
  rollups as (
    select
      root.id as account_id,
      root.account_type,
      coalesce(p_close_mode, root.weekly_accounting_mode, 'CARRY_BALANCE') as close_mode,
      sum(coalesce(pf.opening_balance, 0))::bigint as opening_balance,
      sum(
        case
          when pf.close_mode = 'ZERO_BALANCE' then 0
          else coalesce(pf.current_balance, 0)
        end
      )::bigint as closing_balance,
      sum(coalesce(pf.settled_wins, 0))::bigint as settled_wins,
      sum(coalesce(pf.settled_losses, 0))::bigint as settled_losses,
      sum(coalesce(pf.net_result, 0))::bigint as net_result,
      sum(coalesce(pf.ticket_count, 0))::integer as ticket_count,
      sum(coalesce(pf.pending_exposure, 0))::bigint as pending_exposure,
      case when root.account_type = 'PLAYER' then max(pf.wallet_id) else null end as wallet_id,
      case when root.account_type = 'PLAYER' then max(pf.current_balance) else 0 end as current_balance
    from scoped_accounts root
    left join account_descendants ad on ad.root_id = root.id
    left join player_figures pf on pf.account_id = ad.descendant_id
    group by root.id, root.account_type, root.weekly_accounting_mode
  )
  select
    account_id,
    account_type,
    close_mode,
    coalesce(opening_balance, 0)::bigint as opening_balance,
    case
      when account_type = 'PLAYER' and close_mode = 'ZERO_BALANCE' then 0
      else coalesce(closing_balance, 0)::bigint
    end as closing_balance,
    coalesce(settled_wins, 0)::bigint as settled_wins,
    coalesce(settled_losses, 0)::bigint as settled_losses,
    coalesce(net_result, 0)::bigint as net_result,
    coalesce(ticket_count, 0)::integer as ticket_count,
    coalesce(pending_exposure, 0)::bigint as pending_exposure,
    wallet_id,
    coalesce(current_balance, 0)::bigint as current_balance
  from rollups;

  for v_row in
    select *
    from weekly_accounting_calculation c
    where c.account_type = 'PLAYER'
      and c.close_mode = 'ZERO_BALANCE'
      and c.current_balance <> 0
      and c.wallet_id is not null
      and not exists (
        select 1
        from public.weekly_accounting_snapshots s
        where s.account_id = c.account_id
          and s.week_start = p_week_start
          and s.week_end = p_week_end
          and s.currency = btrim(p_currency)
      )
  loop
    v_zero_entry := public.post_financial_ledger_entry(
      v_row.wallet_id,
      case
        when v_row.current_balance > 0 then 'ZERO_BALANCE_DEBIT'
        else 'ZERO_BALANCE_CREDIT'
      end,
      case
        when v_row.current_balance > 0 then 'DEBIT'
        else 'CREDIT'
      end,
      abs(v_row.current_balance),
      'weekly_accounting',
      v_row.account_id::text || ':' || p_week_start::text || ':' || p_week_end::text,
      'weekly-zero:' || v_row.account_id::text || ':' || p_week_start::text || ':' || p_week_end::text || ':' || btrim(p_currency),
      jsonb_build_object(
        'weekStart', p_week_start,
        'weekEnd', p_week_end,
        'currency', btrim(p_currency),
        'correlationId', p_correlation_id,
        'reason', 'weekly_zero_balance'
      )
    );
  end loop;

  create temp table weekly_accounting_inserted_snapshots
  on commit drop
  as select *
  from public.weekly_accounting_snapshots
  where false;

  with inserted as (
    insert into public.weekly_accounting_snapshots (
      account_id,
      account_type,
      week_start,
      week_end,
      currency,
      opening_balance,
      closing_balance,
      settled_wins,
      settled_losses,
      net_result,
      ticket_count,
      pending_exposure,
      generated_at
    )
    select
      c.account_id,
      c.account_type,
      p_week_start,
      p_week_end,
      btrim(p_currency),
      c.opening_balance,
      c.closing_balance,
      c.settled_wins,
      c.settled_losses,
      c.net_result,
      c.ticket_count,
      c.pending_exposure,
      now()
    from weekly_accounting_calculation c
    on conflict (account_id, week_start, week_end, currency) do nothing
    returning *
  )
  insert into weekly_accounting_inserted_snapshots
  select *
  from inserted;

  select count(*) into v_inserted_count
  from weekly_accounting_inserted_snapshots;

  insert into public.outbox_events (
    event_type,
    aggregate_type,
    aggregate_id,
    payload,
    status,
    correlation_id
  )
  select
    'accounting.snapshot.generated',
    'weekly_accounting_snapshot',
    s.id::text,
    jsonb_build_object(
      'snapshotId', s.id,
      'accountId', s.account_id,
      'accountType', s.account_type,
      'weekStart', s.week_start,
      'weekEnd', s.week_end,
      'currency', s.currency,
      'netResult', s.net_result,
      'ticketCount', s.ticket_count,
      'pendingExposure', s.pending_exposure
    ),
    'PENDING',
    p_correlation_id
  from weekly_accounting_inserted_snapshots s;

  if v_inserted_count > 0 then
    insert into public.outbox_events (
      event_type,
      aggregate_type,
      aggregate_id,
      payload,
      status,
      correlation_id
    )
    values (
      'accounting.week.closed',
      'weekly_accounting',
      coalesce(p_account_scope::text, 'all') || ':' || p_week_start::text || ':' || p_week_end::text || ':' || btrim(p_currency),
      jsonb_build_object(
        'weekStart', p_week_start,
        'weekEnd', p_week_end,
        'accountScope', p_account_scope,
        'currency', btrim(p_currency),
        'snapshotCount', v_inserted_count,
        'closeMode', p_close_mode
      ),
      'PENDING',
      p_correlation_id
    );
  end if;

  return query
  select s.*
  from public.weekly_accounting_snapshots s
  join weekly_accounting_calculation c on c.account_id = s.account_id
  where s.week_start = p_week_start
    and s.week_end = p_week_end
    and s.currency = btrim(p_currency)
  order by
    case s.account_type
      when 'SUPER_MASTER' then 1
      when 'MASTER_AGENT' then 2
      when 'AGENT' then 3
      else 4
    end,
    s.account_id;
end;
$$;
