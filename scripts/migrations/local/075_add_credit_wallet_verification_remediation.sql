create table ledger_service.weekly_accounting_periods (
  period_id uuid primary key,
  brand_id uuid not null references platform.brands(id),
  market_id uuid not null references platform.markets(id),
  period_start_at timestamptz not null,
  period_end_at timestamptz not null,
  status text not null check (status in ('OPEN', 'CLOSED')),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  check (period_end_at > period_start_at),
  check ((status = 'OPEN' and closed_at is null) or (status = 'CLOSED' and closed_at is not null)),
  unique (brand_id, market_id, period_start_at, period_end_at)
);

create index idx_ledger_weekly_period_scope
  on ledger_service.weekly_accounting_periods(brand_id, market_id, period_start_at, period_end_at);
create index idx_ledger_weekly_period_status
  on ledger_service.weekly_accounting_periods(status, period_end_at);

create or replace function ledger_service.validate_weekly_accounting_period()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from platform.markets market
    where market.id = new.market_id and market.brand_id = new.brand_id
  ) then
    raise exception 'Weekly accounting period market must belong to its brand.';
  end if;
  if exists (
    select 1 from ledger_service.weekly_accounting_periods existing
    where existing.brand_id = new.brand_id
      and existing.market_id = new.market_id
      and existing.period_id <> new.period_id
      and tstzrange(existing.period_start_at, existing.period_end_at, '[)')
          && tstzrange(new.period_start_at, new.period_end_at, '[)')
  ) then
    raise exception 'Weekly accounting periods may not overlap within a brand and market.';
  end if;
  return new;
end;
$$;

create or replace function ledger_service.govern_weekly_accounting_period_update()
returns trigger language plpgsql as $$
begin
  if row(new.period_id, new.brand_id, new.market_id, new.period_start_at, new.period_end_at, new.created_at)
     is distinct from
     row(old.period_id, old.brand_id, old.market_id, old.period_start_at, old.period_end_at, old.created_at) then
    raise exception 'Weekly accounting period identity and window are immutable.';
  end if;
  if old.status <> 'OPEN' or new.status <> 'CLOSED' or new.closed_at is null then
    raise exception 'Weekly accounting periods only support governed OPEN to CLOSED transition.';
  end if;
  return new;
end;
$$;

drop trigger if exists ledger_weekly_period_insert_guard on ledger_service.weekly_accounting_periods;
create trigger ledger_weekly_period_insert_guard
before insert on ledger_service.weekly_accounting_periods
for each row execute function ledger_service.validate_weekly_accounting_period();

drop trigger if exists ledger_weekly_period_update_guard on ledger_service.weekly_accounting_periods;
create trigger ledger_weekly_period_update_guard
before update on ledger_service.weekly_accounting_periods
for each row execute function ledger_service.govern_weekly_accounting_period_update();

drop trigger if exists ledger_weekly_period_delete_guard on ledger_service.weekly_accounting_periods;
create trigger ledger_weekly_period_delete_guard
before delete on ledger_service.weekly_accounting_periods
for each row execute function ledger_service.prevent_ledger_evidence_delete();

alter table ledger_service.ledger_posting_requests
  add column accounting_brand_id uuid references platform.brands(id),
  add column accounting_market_id uuid references platform.markets(id),
  add column accounting_posted_at timestamptz not null default now(),
  add column original_accounting_period_id uuid references ledger_service.weekly_accounting_periods(period_id),
  add column posting_accounting_period_id uuid references ledger_service.weekly_accounting_periods(period_id);

create index idx_ledger_posting_requests_accounting_period
  on ledger_service.ledger_posting_requests(posting_accounting_period_id, accounting_posted_at);
create index idx_ledger_posting_requests_original_period
  on ledger_service.ledger_posting_requests(original_accounting_period_id, effective_at);

create or replace function ledger_service.validate_ledger_posting_period()
returns trigger language plpgsql as $$
declare v_posting ledger_service.weekly_accounting_periods%rowtype;
begin
  if new.posting_accounting_period_id is null then
    return new;
  end if;
  select * into v_posting from ledger_service.weekly_accounting_periods
  where period_id = new.posting_accounting_period_id;
  if not found or v_posting.status <> 'OPEN' then
    raise exception 'Ledger posting period is closed or unavailable.';
  end if;
  if new.accounting_brand_id <> v_posting.brand_id
     or new.accounting_market_id <> v_posting.market_id
     or new.accounting_posted_at < v_posting.period_start_at
     or new.accounting_posted_at >= v_posting.period_end_at then
    raise exception 'Ledger posting time and scope must match the current open accounting period.';
  end if;
  return new;
end;
$$;

drop trigger if exists ledger_posting_requests_period_guard on ledger_service.ledger_posting_requests;
create trigger ledger_posting_requests_period_guard
before insert on ledger_service.ledger_posting_requests
for each row execute function ledger_service.validate_ledger_posting_period();

create or replace function ledger_service.validate_ledger_posting_request_update()
returns trigger language plpgsql as $$
begin
  if current_setting('ledger_service.allow_request_status_update', true) <> 'true' then
    raise exception 'Ledger posting requests may only change through governed status persistence.';
  end if;
  if row(
    new.id, new.request_kind, new.instruction_id, new.instruction_type,
    new.instruction_hash, new.originating_authority, new.settlement_record_id,
    new.ledger_wallet_id, new.ledger_account_id, new.direction, new.amount_minor,
    new.currency, new.minor_unit_precision, new.transaction_type,
    new.idempotency_key, new.canonical_request_hash, new.effective_at,
    new.original_ledger_entry_id, new.original_ledger_entry_hash,
    new.correlation_metadata, new.created_at, new.accounting_brand_id,
    new.accounting_market_id, new.accounting_posted_at,
    new.original_accounting_period_id, new.posting_accounting_period_id
  ) is distinct from row(
    old.id, old.request_kind, old.instruction_id, old.instruction_type,
    old.instruction_hash, old.originating_authority, old.settlement_record_id,
    old.ledger_wallet_id, old.ledger_account_id, old.direction, old.amount_minor,
    old.currency, old.minor_unit_precision, old.transaction_type,
    old.idempotency_key, old.canonical_request_hash, old.effective_at,
    old.original_ledger_entry_id, old.original_ledger_entry_hash,
    old.correlation_metadata, old.created_at, old.accounting_brand_id,
    old.accounting_market_id, old.accounting_posted_at,
    old.original_accounting_period_id, old.posting_accounting_period_id
  ) then
    raise exception 'Ledger posting request financial evidence is immutable.';
  end if;
  if old.request_status = 'COMPLETED' and new.request_status <> 'COMPLETED' then
    raise exception 'Completed Ledger posting requests are terminal.';
  end if;
  return new;
end;
$$;

comment on table ledger_service.weekly_accounting_periods is
  'Ledger posting-period control registry. It closes posting windows without changing immutable business effective timestamps.';
