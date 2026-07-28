create extension if not exists pgcrypto;
create schema if not exists platform;

create table if not exists platform.platforms (
  id uuid primary key,
  platform_code text not null,
  name text not null,
  status text not null,
  default_language text not null,
  default_currency text not null,
  default_timezone text not null,
  regulatory_identifier text,
  version text not null,
  content_hash text not null,
  audit_metadata jsonb not null default '{}'::jsonb,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  canonicalized_at timestamptz not null default now(),
  constraint ck_platforms_status check (status in ('Draft', 'Active', 'Suspended', 'Retired')),
  constraint ck_platforms_code check (platform_code = lower(btrim(platform_code)) and platform_code <> ''),
  constraint ck_platforms_name check (btrim(name) <> ''),
  constraint ck_platforms_language check (btrim(default_language) <> ''),
  constraint ck_platforms_currency check (btrim(default_currency) <> ''),
  constraint ck_platforms_timezone check (btrim(default_timezone) <> ''),
  constraint ck_platforms_hash check (content_hash ~ '^sha256:'),
  constraint ck_platforms_effective_window check (effective_to is null or effective_to > effective_from),
  constraint ux_platforms_code_version unique (platform_code, version),
  constraint ux_platforms_content_hash unique (content_hash)
);

create unique index if not exists ux_platforms_singleton
  on platform.platforms ((true));
create index if not exists idx_platforms_status
  on platform.platforms (status);

drop trigger if exists trg_prevent_platform_update on platform.platforms;
create trigger trg_prevent_platform_update
before update on platform.platforms
for each row execute function platform.prevent_platform_foundation_update();

drop trigger if exists trg_prevent_platform_delete on platform.platforms;
create trigger trg_prevent_platform_delete
before delete on platform.platforms
for each row execute function platform.prevent_platform_foundation_delete();

insert into platform.platforms (
  id,
  platform_code,
  name,
  status,
  default_language,
  default_currency,
  default_timezone,
  version,
  content_hash,
  audit_metadata
)
values (
  '00000000-0000-4000-8000-000000000001',
  'mosera',
  'Mosera',
  'Active',
  'en',
  'USD',
  'UTC',
  '1.0.0',
  'sha256:canonical-platform-root-v1',
  '{"source":"migration","reason":"P1-013.1 canonical platform hierarchy"}'::jsonb
)
on conflict (id) do nothing;

alter table platform.organizations
  add column if not exists platform_id uuid not null
    default '00000000-0000-4000-8000-000000000001'
    references platform.platforms(id);

create index if not exists idx_platform_organizations_platform_code
  on platform.organizations (platform_id, organization_code);

alter table platform.websites
  add constraint ck_platform_websites_market_required
  check (market_id is not null) not valid;

create or replace function platform.validate_platform_website()
returns trigger
language plpgsql
as $$
declare
  brand_tenant_id uuid;
  market_brand_id uuid;
  market_language text;
  market_currency text;
  market_timezone text;
begin
  if btrim(new.website_code) = '' then
    raise exception 'website_code is required';
  end if;

  if btrim(new.display_name) = '' then
    raise exception 'website display_name is required';
  end if;

  if new.market_id is null then
    raise exception 'website market_id is required by the canonical Platform hierarchy';
  end if;

  if btrim(new.version) = '' then
    raise exception 'website version is required';
  end if;

  if new.content_hash !~ '^sha256:' then
    raise exception 'website content_hash must use sha256 prefix';
  end if;

  select tenant_id
  into brand_tenant_id
  from platform.brands
  where id = new.brand_id;

  if brand_tenant_id is null then
    raise exception 'website brand_id must reference an existing brand';
  end if;

  if brand_tenant_id <> new.tenant_id then
    raise exception 'website tenant_id must match brand tenant_id';
  end if;

  select brand_id, language, currency, timezone
  into market_brand_id, market_language, market_currency, market_timezone
  from platform.markets
  where id = new.market_id;

  if market_brand_id is null then
    raise exception 'website market_id must reference an existing market';
  end if;

  if market_brand_id <> new.brand_id then
    raise exception 'website market_id must belong to website brand_id';
  end if;

  new.default_language := coalesce(nullif(btrim(new.default_language), ''), market_language);
  new.default_currency := coalesce(nullif(btrim(new.default_currency), ''), market_currency);
  new.default_timezone := coalesce(nullif(btrim(new.default_timezone), ''), market_timezone);

  if row(new.default_language, new.default_currency, new.default_timezone)
     is distinct from row(market_language, market_currency, market_timezone) then
    raise exception 'website locale, currency, and timezone must match its canonical market';
  end if;

  return new;
end;
$$;

create or replace function platform.validate_canonical_parent_status()
returns trigger
language plpgsql
as $$
declare
  parent_ready boolean;
begin
  if new.status <> 'Active' then
    return new;
  end if;

  case tg_table_name
    when 'organizations' then
      select exists (
        select 1 from platform.platforms
        where id = new.platform_id and status = 'Active'
      ) into parent_ready;
    when 'tenants' then
      select exists (
        select 1 from platform.organizations
        where id = new.organization_id and status = 'Active'
      ) into parent_ready;
    when 'brands' then
      select exists (
        select 1 from platform.tenants
        where id = new.tenant_id and status = 'Active'
      ) into parent_ready;
    when 'markets' then
      select exists (
        select 1 from platform.brands
        where id = new.brand_id and status = 'Active'
      ) into parent_ready;
    when 'websites' then
      select exists (
        select 1
        from platform.markets market
        join platform.brands brand on brand.id = market.brand_id
        join platform.tenants tenant on tenant.id = brand.tenant_id
        join platform.organizations organization on organization.id = tenant.organization_id
        join platform.platforms platform on platform.id = organization.platform_id
        where market.id = new.market_id
          and market.brand_id = new.brand_id
          and brand.tenant_id = new.tenant_id
          and market.status = 'Active'
          and brand.status = 'Active'
          and tenant.status = 'Active'
          and organization.status = 'Active'
          and platform.status = 'Active'
      ) into parent_ready;
    else
      parent_ready := false;
  end case;

  if not coalesce(parent_ready, false) then
    raise exception 'Active % requires its complete canonical parent chain to be Active', tg_table_name;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_canonical_organization_parent on platform.organizations;
create trigger trg_validate_canonical_organization_parent
before insert on platform.organizations
for each row execute function platform.validate_canonical_parent_status();

drop trigger if exists trg_validate_canonical_tenant_parent on platform.tenants;
create trigger trg_validate_canonical_tenant_parent
before insert on platform.tenants
for each row execute function platform.validate_canonical_parent_status();

drop trigger if exists trg_validate_canonical_brand_parent on platform.brands;
create trigger trg_validate_canonical_brand_parent
before insert on platform.brands
for each row execute function platform.validate_canonical_parent_status();

drop trigger if exists trg_validate_canonical_market_parent on platform.markets;
create trigger trg_validate_canonical_market_parent
before insert on platform.markets
for each row execute function platform.validate_canonical_parent_status();

drop trigger if exists trg_validate_canonical_website_parent on platform.websites;
create trigger trg_validate_canonical_website_parent
before insert on platform.websites
for each row execute function platform.validate_canonical_parent_status();

create or replace view platform.active_host_resolutions as
select
  d.hostname,
  w.tenant_id,
  w.brand_id,
  w.market_id,
  w.id as website_id,
  w.website_code,
  w.display_name as website_display_name,
  d.id as domain_id,
  d.canonical,
  case when d.canonical then null else canonical_domain.hostname end as canonical_redirect_target,
  w.maintenance_mode,
  m.language as default_language,
  m.currency as default_currency,
  m.timezone as default_timezone,
  d.tls_mode_placeholder,
  d.cloudflare_proxy_metadata_placeholder,
  d.effective_from,
  d.effective_to
from platform.website_domains d
join platform.websites w on w.id = d.website_id
join platform.tenants t on t.id = w.tenant_id
join platform.organizations o on o.id = t.organization_id
join platform.platforms p on p.id = o.platform_id
join platform.brands b on b.id = w.brand_id and b.tenant_id = t.id
join platform.markets m on m.id = w.market_id and m.brand_id = b.id
left join lateral (
  select lifecycle.to_status
  from platform.platform_lifecycle_events lifecycle
  where lifecycle.resource = 'domains' and lifecycle.record_id = d.id
  order by lifecycle.created_at desc, lifecycle.event_id desc
  limit 1
) d_lifecycle on true
left join lateral (
  select lifecycle.to_status
  from platform.platform_lifecycle_events lifecycle
  where lifecycle.resource = 'websites' and lifecycle.record_id = w.id
  order by lifecycle.created_at desc, lifecycle.event_id desc
  limit 1
) w_lifecycle on true
left join lateral (
  select lifecycle.to_status
  from platform.platform_lifecycle_events lifecycle
  where lifecycle.resource = 'organizations' and lifecycle.record_id = o.id
  order by lifecycle.created_at desc, lifecycle.event_id desc
  limit 1
) o_lifecycle on true
left join lateral (
  select lifecycle.to_status
  from platform.platform_lifecycle_events lifecycle
  where lifecycle.resource = 'tenants' and lifecycle.record_id = t.id
  order by lifecycle.created_at desc, lifecycle.event_id desc
  limit 1
) t_lifecycle on true
left join lateral (
  select lifecycle.to_status
  from platform.platform_lifecycle_events lifecycle
  where lifecycle.resource = 'brands' and lifecycle.record_id = b.id
  order by lifecycle.created_at desc, lifecycle.event_id desc
  limit 1
) b_lifecycle on true
left join lateral (
  select lifecycle.to_status
  from platform.platform_lifecycle_events lifecycle
  where lifecycle.resource = 'markets' and lifecycle.record_id = m.id
  order by lifecycle.created_at desc, lifecycle.event_id desc
  limit 1
) m_lifecycle on true
left join lateral (
  select cd.hostname
  from platform.website_domains cd
  left join lateral (
    select lifecycle.to_status
    from platform.platform_lifecycle_events lifecycle
    where lifecycle.resource = 'domains' and lifecycle.record_id = cd.id
    order by lifecycle.created_at desc, lifecycle.event_id desc
    limit 1
  ) cd_lifecycle on true
  where cd.website_id = w.id
    and cd.canonical = true
    and coalesce(cd_lifecycle.to_status, cd.status) = 'Active'
    and cd.verification_status = 'Verified'
    and cd.effective_from <= now()
    and (cd.effective_to is null or cd.effective_to > now())
  order by cd.effective_from desc
  limit 1
) canonical_domain on true
where p.status = 'Active'
  and coalesce(o_lifecycle.to_status, o.status) = 'Active'
  and coalesce(t_lifecycle.to_status, t.status) = 'Active'
  and coalesce(b_lifecycle.to_status, b.status) = 'Active'
  and coalesce(m_lifecycle.to_status, m.status) = 'Active'
  and coalesce(w_lifecycle.to_status, w.status) = 'Active'
  and coalesce(d_lifecycle.to_status, d.status) = 'Active'
  and d.verification_status = 'Verified'
  and d.effective_from <= now()
  and (d.effective_to is null or d.effective_to > now());

create or replace function platform.canonical_hierarchy_readiness()
returns table (
  check_name text,
  ready boolean,
  issue_count bigint
)
language sql
stable
as $$
with root as (
  select canonicalized_at
  from platform.platforms
  where id = '00000000-0000-4000-8000-000000000001'
),
checks as (
  select 'platform_root'::text as check_name,
    (select count(*) from platform.platforms where status = 'Active') = 1 as ready,
    abs((select count(*) from platform.platforms where status = 'Active') - 1)::bigint as issue_count
  union all
  select 'organization_parent',
    count(*) = 0,
    count(*)
  from platform.organizations o
  left join platform.platforms p on p.id = o.platform_id
  where p.id is null
  union all
  select 'tenant_parent',
    count(*) = 0,
    count(*)
  from platform.tenants t
  left join platform.organizations o on o.id = t.organization_id
  where o.id is null
  union all
  select 'brand_parent',
    count(*) = 0,
    count(*)
  from platform.brands b
  left join platform.tenants t on t.id = b.tenant_id
  where t.id is null
  union all
  select 'market_parent',
    count(*) = 0,
    count(*)
  from platform.markets m
  left join platform.brands b on b.id = m.brand_id
  where b.id is null
  union all
  select 'website_parent',
    count(*) = 0,
    count(*)
  from platform.websites w
  cross join root
  left join platform.brands b on b.id = w.brand_id and b.tenant_id = w.tenant_id
  left join platform.markets m on m.id = w.market_id and m.brand_id = w.brand_id
  where w.created_at >= root.canonicalized_at
    and (b.id is null or m.id is null)
  union all
  select 'active_parent_chain',
    count(*) = 0,
    count(*)
  from platform.websites w
  cross join root
  join platform.markets m on m.id = w.market_id
  join platform.brands b on b.id = m.brand_id
  join platform.tenants t on t.id = b.tenant_id
  join platform.organizations o on o.id = t.organization_id
  join platform.platforms p on p.id = o.platform_id
  where w.created_at >= root.canonicalized_at
    and w.status = 'Active'
    and (m.status <> 'Active' or b.status <> 'Active' or t.status <> 'Active'
      or o.status <> 'Active' or p.status <> 'Active')
  union all
  select 'auth_scope_references',
    count(*) = 0,
    count(*)
  from auth_service.identity_profiles i
  left join platform.tenants t on t.id = i.tenant_id
  left join platform.brands b on b.id = i.brand_id and b.tenant_id = i.tenant_id
  where t.id is null or (i.brand_id is not null and b.id is null)
  union all
  select 'wallet_scope_references',
    count(*) = 0,
    count(*)
  from public.credit_reservations r
  left join platform.tenants t on t.id = r.tenant_id
  left join platform.brands b on b.id = r.brand_id and b.tenant_id = r.tenant_id
  where r.tenant_id is not null and (t.id is null or b.id is null)
  union all
  select 'ledger_scope_references',
    count(*) = 0,
    count(*)
  from ledger_service.weekly_accounting_periods period
  left join platform.markets m on m.id = period.market_id and m.brand_id = period.brand_id
  where m.id is null
  union all
  select 'settlement_scope_references',
    count(*) = 0,
    count(*)
  from settlement_service.settlement_requests request
  left join platform.tenants t on t.id = request.tenant_id
  left join platform.brands b on b.id = request.brand_id and b.tenant_id = request.tenant_id
  where request.tenant_id is not null and (t.id is null or b.id is null)
  union all
  select 'outcome_scope_references',
    count(*) = 0,
    count(*)
  from platform.game_availability availability
  left join platform.tenants t on t.id = availability.tenant_id
  left join platform.brands b on b.id = availability.brand_id and b.tenant_id = availability.tenant_id
  left join platform.markets m on m.id = availability.market_id and m.brand_id = availability.brand_id
  left join platform.websites w on w.id = availability.website_id
    and w.tenant_id = availability.tenant_id
    and w.brand_id = availability.brand_id
  where t.id is null
    or b.id is null
    or (availability.market_id is not null and m.id is null)
    or (availability.website_id is not null and w.id is null)
)
select checks.check_name, checks.ready, checks.issue_count
from checks
order by checks.check_name;
$$;
