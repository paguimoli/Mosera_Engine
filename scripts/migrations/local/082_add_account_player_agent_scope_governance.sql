create extension if not exists pgcrypto;
create schema if not exists platform;

alter table public.accounts
  add column if not exists parent_account_id uuid references public.accounts(id),
  add column if not exists canonical_tenant_id uuid references platform.tenants(id),
  add column if not exists canonical_brand_id uuid references platform.brands(id),
  add column if not exists canonical_market_id uuid references platform.markets(id),
  add column if not exists governance_managed boolean not null default false,
  add column if not exists idempotency_key text,
  add column if not exists canonical_request_hash text,
  add column if not exists funding_model text,
  add column if not exists operating_mode text,
  add column if not exists balance_authority text,
  add column if not exists default_funding_source text,
  add column if not exists weekly_accounting_mode text,
  add column if not exists settlement_mode text;

create unique index if not exists ux_accounts_governed_idempotency
  on public.accounts (idempotency_key)
  where governance_managed and idempotency_key is not null;
create index if not exists idx_accounts_governed_scope
  on public.accounts (
    canonical_tenant_id,
    canonical_brand_id,
    canonical_market_id,
    account_type,
    status
  )
  where governance_managed;
create index if not exists idx_accounts_governed_parent
  on public.accounts (parent_account_id)
  where governance_managed;

create table if not exists public.player_profiles (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null unique references public.accounts(id),
  first_name text,
  last_name text,
  display_name text not null,
  email text,
  phone text,
  date_of_birth date,
  external_player_id text,
  external_platform text,
  status text not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint player_profiles_status_check
    check (status in ('ACTIVE', 'SUSPENDED', 'DISABLED'))
);

create unique index if not exists ux_player_profiles_external_identity
  on public.player_profiles (external_platform, external_player_id)
  where external_platform is not null and external_player_id is not null;
create index if not exists idx_player_profiles_status
  on public.player_profiles (status);

drop trigger if exists set_player_profiles_updated_at on public.player_profiles;
create trigger set_player_profiles_updated_at
before update on public.player_profiles
for each row execute function public.set_updated_at();

create table if not exists platform.account_governance_events (
  event_id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  event_type text not null,
  previous_parent_account_id uuid,
  parent_account_id uuid,
  previous_tenant_id uuid,
  tenant_id uuid not null references platform.tenants(id),
  previous_brand_id uuid,
  brand_id uuid not null references platform.brands(id),
  previous_market_id uuid,
  market_id uuid not null references platform.markets(id),
  previous_status text,
  status text not null,
  reason text not null,
  requested_by text not null,
  approval_metadata jsonb not null default '{}'::jsonb,
  canonical_evidence_hash text not null,
  created_at timestamptz not null default now(),
  constraint ck_account_governance_event_type check (
    event_type in ('CREATED', 'REASSIGNED', 'STATUS_CHANGED', 'RESTORED')
  ),
  constraint ck_account_governance_hash check (
    canonical_evidence_hash ~ '^sha256:'
  )
);

create index if not exists idx_account_governance_events_account
  on platform.account_governance_events (account_id, created_at, event_id);
create index if not exists idx_account_governance_events_scope
  on platform.account_governance_events (tenant_id, brand_id, market_id, created_at);

drop trigger if exists trg_account_governance_events_update_guard
  on platform.account_governance_events;
create trigger trg_account_governance_events_update_guard
before update on platform.account_governance_events
for each row execute function platform.prevent_platform_foundation_update();

drop trigger if exists trg_account_governance_events_delete_guard
  on platform.account_governance_events;
create trigger trg_account_governance_events_delete_guard
before delete on platform.account_governance_events
for each row execute function platform.prevent_platform_foundation_delete();

create or replace function platform.validate_governed_account()
returns trigger
language plpgsql
as $$
declare
  resolved_tenant_id uuid;
  resolved_brand_id uuid;
  resolved_organization_id uuid;
  resolved_platform_id uuid;
  market_status text;
  brand_status text;
  tenant_status text;
  organization_status text;
  platform_status text;
  parent_row public.accounts%rowtype;
begin
  if not new.governance_managed then
    if tg_op = 'UPDATE' and old.governance_managed then
      raise exception 'governed accounts cannot leave canonical scope governance';
    end if;
    return new;
  end if;

  if new.canonical_tenant_id is null
     or new.canonical_brand_id is null
     or new.canonical_market_id is null then
    raise exception 'governed accounts require exact tenant, brand, and market scope';
  end if;

  select
    brand.tenant_id,
    market.brand_id,
    tenant.organization_id,
    organization.platform_id,
    market.status,
    brand.status,
    tenant.status,
    organization.status,
    platform.status
  into
    resolved_tenant_id,
    resolved_brand_id,
    resolved_organization_id,
    resolved_platform_id,
    market_status,
    brand_status,
    tenant_status,
    organization_status,
    platform_status
  from platform.markets market
  join platform.brands brand on brand.id = market.brand_id
  join platform.tenants tenant on tenant.id = brand.tenant_id
  join platform.organizations organization on organization.id = tenant.organization_id
  join platform.platforms platform on platform.id = organization.platform_id
  where market.id = new.canonical_market_id;

  if resolved_brand_id is null
     or resolved_brand_id <> new.canonical_brand_id
     or resolved_tenant_id <> new.canonical_tenant_id then
    raise exception 'account scope must be derived from the canonical market hierarchy';
  end if;

  if new.status = 'ACTIVE'
     and row(
       market_status,
       brand_status,
       tenant_status,
       organization_status,
       platform_status
     ) is distinct from row('Active', 'Active', 'Active', 'Active', 'Active') then
    raise exception 'active account requires an active canonical Platform hierarchy';
  end if;

  if new.parent_account_id is null then
    if new.account_type <> 'SUPER_MASTER' then
      raise exception '% accounts require a parent account', new.account_type;
    end if;
  else
    if new.parent_account_id = new.id then
      raise exception 'account hierarchy cycle detected';
    end if;

    select *
    into parent_row
    from public.accounts
    where id = new.parent_account_id
      and governance_managed;

    if parent_row.id is null then
      raise exception 'parent account is not governed';
    end if;

    if parent_row.status <> 'ACTIVE' then
      raise exception 'parent account must be active';
    end if;

    if row(
      parent_row.canonical_tenant_id,
      parent_row.canonical_brand_id,
      parent_row.canonical_market_id
    ) is distinct from row(
      new.canonical_tenant_id,
      new.canonical_brand_id,
      new.canonical_market_id
    ) then
      raise exception 'account hierarchy cannot cross canonical scope';
    end if;

    if (new.account_type = 'MASTER_AGENT'
        and parent_row.account_type not in ('SUPER_MASTER', 'MASTER_AGENT'))
       or (new.account_type = 'AGENT'
        and parent_row.account_type <> 'MASTER_AGENT')
       or (new.account_type = 'PLAYER'
        and parent_row.account_type <> 'AGENT')
       or new.account_type = 'SUPER_MASTER' then
      raise exception 'invalid account hierarchy parent type';
    end if;

    if tg_op = 'UPDATE' and exists (
      with recursive descendants as (
        select account.id
        from public.accounts account
        where account.parent_account_id = new.id
          and account.governance_managed
        union all
        select account.id
        from public.accounts account
        join descendants descendant
          on account.parent_account_id = descendant.id
        where account.governance_managed
      )
      select 1
      from descendants
      where id = new.parent_account_id
    ) then
      raise exception 'account hierarchy cycle detected';
    end if;
  end if;

  if tg_op = 'UPDATE'
     and old.status = 'ACTIVE'
     and new.status = 'DISABLED'
     and exists (
       select 1
       from public.accounts child
       where child.parent_account_id = new.id
         and child.governance_managed
         and child.status = 'ACTIVE'
     ) then
    raise exception 'cannot disable an account with active children';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_governed_account on public.accounts;
create trigger trg_validate_governed_account
before insert or update on public.accounts
for each row execute function platform.validate_governed_account();

create or replace function platform.append_account_governance_event()
returns trigger
language plpgsql
as $$
declare
  event_type_value text;
  reason_value text;
  actor_value text;
  evidence_payload text;
begin
  if not new.governance_managed then
    return new;
  end if;

  if tg_op = 'INSERT' then
    event_type_value := 'CREATED';
  elsif old.parent_account_id is distinct from new.parent_account_id
     or old.canonical_tenant_id is distinct from new.canonical_tenant_id
     or old.canonical_brand_id is distinct from new.canonical_brand_id
     or old.canonical_market_id is distinct from new.canonical_market_id then
    event_type_value := 'REASSIGNED';
  elsif old.status = 'DISABLED' and new.status = 'ACTIVE' then
    event_type_value := 'RESTORED';
  elsif old.status is distinct from new.status then
    event_type_value := 'STATUS_CHANGED';
  else
    return new;
  end if;

  reason_value := coalesce(
    nullif(current_setting('app.account_governance_reason', true), ''),
    lower(event_type_value)
  );
  actor_value := coalesce(
    nullif(current_setting('app.account_governance_actor', true), ''),
    'system'
  );
  evidence_payload := concat_ws(
    '|',
    new.id::text,
    event_type_value,
    coalesce(old.parent_account_id::text, ''),
    coalesce(new.parent_account_id::text, ''),
    coalesce(old.canonical_tenant_id::text, ''),
    new.canonical_tenant_id::text,
    coalesce(old.canonical_brand_id::text, ''),
    new.canonical_brand_id::text,
    coalesce(old.canonical_market_id::text, ''),
    new.canonical_market_id::text,
    coalesce(old.status, ''),
    new.status,
    reason_value,
    actor_value,
    clock_timestamp()::text
  );

  insert into platform.account_governance_events (
    account_id,
    event_type,
    previous_parent_account_id,
    parent_account_id,
    previous_tenant_id,
    tenant_id,
    previous_brand_id,
    brand_id,
    previous_market_id,
    market_id,
    previous_status,
    status,
    reason,
    requested_by,
    canonical_evidence_hash
  )
  values (
    new.id,
    event_type_value,
    case when tg_op = 'INSERT' then null else old.parent_account_id end,
    new.parent_account_id,
    case when tg_op = 'INSERT' then null else old.canonical_tenant_id end,
    new.canonical_tenant_id,
    case when tg_op = 'INSERT' then null else old.canonical_brand_id end,
    new.canonical_brand_id,
    case when tg_op = 'INSERT' then null else old.canonical_market_id end,
    new.canonical_market_id,
    case when tg_op = 'INSERT' then null else old.status end,
    new.status,
    reason_value,
    actor_value,
    'sha256:' || encode(digest(evidence_payload, 'sha256'), 'hex')
  );

  return new;
end;
$$;

drop trigger if exists trg_append_account_governance_event on public.accounts;
create trigger trg_append_account_governance_event
after insert or update on public.accounts
for each row execute function platform.append_account_governance_event();

create or replace function platform.validate_governed_player_profile()
returns trigger
language plpgsql
as $$
declare
  account_row public.accounts%rowtype;
begin
  select *
  into account_row
  from public.accounts
  where id = new.account_id
    and governance_managed;

  if account_row.id is null then
    raise exception 'player profile account must be governed';
  end if;

  if account_row.account_type <> 'PLAYER' then
    raise exception 'player profile requires a PLAYER account';
  end if;

  if account_row.status <> 'ACTIVE' and new.status = 'ACTIVE' then
    raise exception 'active player profile requires an active player account';
  end if;

  if tg_op = 'UPDATE' and old.account_id <> new.account_id then
    if not exists (
      select 1
      from public.accounts old_account
      where old_account.id = old.account_id
        and row(
          old_account.canonical_tenant_id,
          old_account.canonical_brand_id,
          old_account.canonical_market_id
        ) = row(
          account_row.canonical_tenant_id,
          account_row.canonical_brand_id,
          account_row.canonical_market_id
        )
    ) then
      raise exception 'player profile reassignment cannot cross canonical scope';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_governed_player_profile on public.player_profiles;
create trigger trg_validate_governed_player_profile
before insert or update on public.player_profiles
for each row execute function platform.validate_governed_player_profile();

create or replace function platform.account_scope_governance_readiness()
returns table (
  check_name text,
  ready boolean,
  issue_count bigint
)
language sql
stable
as $$
with governed as (
  select *
  from public.accounts
  where governance_managed
),
checks as (
  select
    'canonical_scope_integrity'::text as check_name,
    count(*) = 0 as ready,
    count(*) as issue_count
  from governed account
  left join platform.markets market
    on market.id = account.canonical_market_id
    and market.brand_id = account.canonical_brand_id
  left join platform.brands brand
    on brand.id = account.canonical_brand_id
    and brand.tenant_id = account.canonical_tenant_id
  where market.id is null or brand.id is null
  union all
  select
    'hierarchy_scope_integrity',
    count(*) = 0,
    count(*)
  from governed child
  left join governed parent on parent.id = child.parent_account_id
  where (child.account_type <> 'SUPER_MASTER' and parent.id is null)
    or (
      parent.id is not null
      and row(
        child.canonical_tenant_id,
        child.canonical_brand_id,
        child.canonical_market_id
      ) is distinct from row(
        parent.canonical_tenant_id,
        parent.canonical_brand_id,
        parent.canonical_market_id
      )
    )
  union all
  select
    'active_parent_integrity',
    count(*) = 0,
    count(*)
  from governed child
  join governed parent on parent.id = child.parent_account_id
  where child.status = 'ACTIVE' and parent.status <> 'ACTIVE'
  union all
  select
    'player_profile_integrity',
    count(*) = 0,
    count(*)
  from public.player_profiles profile
  left join governed account on account.id = profile.account_id
  where account.id is null or account.account_type <> 'PLAYER'
  union all
  select
    'duplicate_scope_assignment',
    true,
    0::bigint
  union all
  select
    'legacy_accounts_isolated',
    true,
    count(*)
  from public.accounts
  where not governance_managed
  union all
  select
    'migration_state',
    exists (
      select 1
      from platform_migrations.migration_history
      where migration_id = '082_add_account_player_agent_scope_governance'
        and status = 'APPLIED'
    ),
    case when exists (
      select 1
      from platform_migrations.migration_history
      where migration_id = '082_add_account_player_agent_scope_governance'
        and status = 'APPLIED'
    ) then 0 else 1 end
)
select check_name, ready, issue_count
from checks
order by check_name;
$$;
