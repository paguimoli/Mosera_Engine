create extension if not exists pgcrypto;

create table if not exists platform.platform_lifecycle_events (
  event_id uuid primary key default gen_random_uuid(),
  resource text not null,
  record_id uuid not null,
  entity_key jsonb not null,
  from_status text not null,
  to_status text not null,
  from_version text not null,
  to_version text not null,
  supersedes_record_id uuid,
  superseded_by_record_id uuid,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  reason text not null,
  operator text not null,
  approval_metadata jsonb not null default '{}'::jsonb,
  event_hash text not null,
  created_at timestamptz not null default now(),
  constraint ck_platform_lifecycle_resource check (
    resource in (
      'organizations',
      'tenants',
      'brands',
      'markets',
      'websites',
      'domains',
      'themes',
      'brand-assets',
      'game-availability'
    )
  ),
  constraint ck_platform_lifecycle_statuses check (
    from_status in ('Draft', 'Active', 'Suspended', 'Retired', 'Superseded', 'Cancelled', 'PendingVerification')
    and to_status in ('Draft', 'Active', 'Suspended', 'Retired', 'Superseded', 'Cancelled')
  ),
  constraint ck_platform_lifecycle_hash check (event_hash ~ '^sha256:'),
  constraint ck_platform_lifecycle_effective_window check (effective_to is null or effective_to > effective_from),
  constraint ck_platform_lifecycle_reason check (btrim(reason) <> ''),
  constraint ck_platform_lifecycle_operator check (btrim(operator) <> ''),
  constraint ux_platform_lifecycle_event_hash unique (event_hash)
);

create index if not exists idx_platform_lifecycle_resource_record
  on platform.platform_lifecycle_events(resource, record_id, created_at);

create index if not exists idx_platform_lifecycle_resource_status
  on platform.platform_lifecycle_events(resource, to_status, created_at);

create index if not exists idx_platform_lifecycle_entity_key
  on platform.platform_lifecycle_events using gin(entity_key);

drop trigger if exists trg_prevent_platform_lifecycle_events_update on platform.platform_lifecycle_events;
create trigger trg_prevent_platform_lifecycle_events_update
before update on platform.platform_lifecycle_events
for each row execute function platform.prevent_platform_foundation_update();

drop trigger if exists trg_prevent_platform_lifecycle_events_delete on platform.platform_lifecycle_events;
create trigger trg_prevent_platform_lifecycle_events_delete
before delete on platform.platform_lifecycle_events
for each row execute function platform.prevent_platform_foundation_delete();

alter table platform.organizations
  add column if not exists effective_from timestamptz not null default now(),
  add column if not exists effective_to timestamptz,
  add column if not exists previous_version text,
  add column if not exists supersedes_version text,
  add column if not exists lifecycle_reason text,
  add column if not exists lifecycle_operator text,
  add column if not exists approval_metadata jsonb not null default '{}'::jsonb;

alter table platform.tenants
  add column if not exists effective_from timestamptz not null default now(),
  add column if not exists effective_to timestamptz,
  add column if not exists previous_version text,
  add column if not exists supersedes_version text,
  add column if not exists lifecycle_reason text,
  add column if not exists lifecycle_operator text,
  add column if not exists approval_metadata jsonb not null default '{}'::jsonb;

alter table platform.brands
  add column if not exists effective_from timestamptz not null default now(),
  add column if not exists effective_to timestamptz,
  add column if not exists previous_version text,
  add column if not exists supersedes_version text,
  add column if not exists lifecycle_reason text,
  add column if not exists lifecycle_operator text,
  add column if not exists approval_metadata jsonb not null default '{}'::jsonb;

alter table platform.markets
  add column if not exists effective_from timestamptz not null default now(),
  add column if not exists effective_to timestamptz,
  add column if not exists previous_version text,
  add column if not exists supersedes_version text,
  add column if not exists lifecycle_reason text,
  add column if not exists lifecycle_operator text,
  add column if not exists approval_metadata jsonb not null default '{}'::jsonb;

alter table platform.websites
  add column if not exists effective_from timestamptz not null default now(),
  add column if not exists effective_to timestamptz,
  add column if not exists previous_version text,
  add column if not exists supersedes_version text,
  add column if not exists lifecycle_reason text,
  add column if not exists lifecycle_operator text,
  add column if not exists approval_metadata jsonb not null default '{}'::jsonb;

alter table platform.website_domains
  add column if not exists previous_version text,
  add column if not exists supersedes_version text,
  add column if not exists lifecycle_reason text,
  add column if not exists lifecycle_operator text,
  add column if not exists approval_metadata jsonb not null default '{}'::jsonb;

alter table platform.brand_themes
  add column if not exists effective_from timestamptz not null default now(),
  add column if not exists effective_to timestamptz,
  add column if not exists previous_version text,
  add column if not exists supersedes_version text,
  add column if not exists lifecycle_reason text,
  add column if not exists lifecycle_operator text,
  add column if not exists approval_metadata jsonb not null default '{}'::jsonb;

alter table platform.brand_assets
  add column if not exists effective_from timestamptz not null default now(),
  add column if not exists effective_to timestamptz,
  add column if not exists previous_version text,
  add column if not exists supersedes_version text,
  add column if not exists lifecycle_reason text,
  add column if not exists lifecycle_operator text,
  add column if not exists approval_metadata jsonb not null default '{}'::jsonb;

alter table platform.game_availability
  add column if not exists previous_version text,
  add column if not exists supersedes_version text,
  add column if not exists lifecycle_reason text,
  add column if not exists lifecycle_operator text,
  add column if not exists approval_metadata jsonb not null default '{}'::jsonb;

alter table platform.organizations drop constraint if exists ck_platform_organizations_status;
alter table platform.organizations
  add constraint ck_platform_organizations_status
  check (status in ('Draft', 'Active', 'Suspended', 'Retired', 'Superseded', 'Cancelled'));

alter table platform.tenants drop constraint if exists ck_platform_tenants_status;
alter table platform.tenants
  add constraint ck_platform_tenants_status
  check (status in ('Draft', 'Active', 'Suspended', 'Retired', 'Superseded', 'Cancelled'));

alter table platform.brands drop constraint if exists ck_platform_brands_status;
alter table platform.brands
  add constraint ck_platform_brands_status
  check (status in ('Draft', 'Active', 'Suspended', 'Retired', 'Superseded', 'Cancelled'));

alter table platform.markets drop constraint if exists ck_platform_markets_status;
alter table platform.markets
  add constraint ck_platform_markets_status
  check (status in ('Draft', 'Active', 'Suspended', 'Retired', 'Superseded', 'Cancelled'));

alter table platform.websites drop constraint if exists ck_platform_websites_status;
alter table platform.websites
  add constraint ck_platform_websites_status
  check (status in ('Draft', 'Active', 'Suspended', 'Retired', 'Superseded', 'Cancelled'));

alter table platform.website_domains drop constraint if exists ck_platform_website_domains_status;
alter table platform.website_domains
  add constraint ck_platform_website_domains_status
  check (status in ('PendingVerification', 'Draft', 'Active', 'Suspended', 'Retired', 'Superseded', 'Cancelled'));

alter table platform.brand_themes drop constraint if exists ck_platform_brand_themes_status;
alter table platform.brand_themes
  add constraint ck_platform_brand_themes_status
  check (status in ('Draft', 'Active', 'Suspended', 'Retired', 'Superseded', 'Cancelled'));

alter table platform.brand_assets drop constraint if exists ck_platform_brand_assets_status;
alter table platform.brand_assets
  add constraint ck_platform_brand_assets_status
  check (status in ('Draft', 'Active', 'Suspended', 'Retired', 'Superseded', 'Cancelled'));

alter table platform.game_availability drop constraint if exists ck_platform_game_availability_status;
alter table platform.game_availability
  add constraint ck_platform_game_availability_status
  check (status in ('Draft', 'Active', 'Suspended', 'Retired', 'Superseded', 'Cancelled'));

alter table platform.websites drop constraint if exists ux_platform_websites_brand_code;
create unique index if not exists ux_platform_websites_brand_code_version
  on platform.websites(brand_id, website_code, version);

alter table platform.website_domains drop constraint if exists ux_platform_website_domains_hostname;
drop index if exists ux_platform_website_domains_canonical_website;
create unique index if not exists ux_platform_website_domains_hostname_version
  on platform.website_domains(hostname, version);
create unique index if not exists ux_platform_website_domains_canonical_website_version
  on platform.website_domains(website_id, version)
  where canonical = true;

alter table platform.brand_themes drop constraint if exists ux_platform_brand_themes_brand_code;
drop index if exists ux_platform_brand_themes_active_default_brand;
create unique index if not exists ux_platform_brand_themes_brand_code_version
  on platform.brand_themes(brand_id, theme_code, version);
create unique index if not exists ux_platform_brand_themes_active_default_brand_version
  on platform.brand_themes(brand_id, version)
  where is_default = true and status = 'Active';

create index if not exists idx_platform_organizations_effective_window on platform.organizations(effective_from, effective_to);
create index if not exists idx_platform_tenants_effective_window on platform.tenants(effective_from, effective_to);
create index if not exists idx_platform_brands_effective_window on platform.brands(effective_from, effective_to);
create index if not exists idx_platform_markets_effective_window on platform.markets(effective_from, effective_to);
create index if not exists idx_platform_websites_effective_window on platform.websites(effective_from, effective_to);
create index if not exists idx_platform_brand_themes_effective_window on platform.brand_themes(effective_from, effective_to);
create index if not exists idx_platform_brand_assets_effective_window on platform.brand_assets(effective_from, effective_to);

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
  case
    when d.canonical then null
    else canonical_domain.hostname
  end as canonical_redirect_target,
  w.maintenance_mode,
  w.default_language,
  w.default_currency,
  w.default_timezone,
  d.tls_mode_placeholder,
  d.cloudflare_proxy_metadata_placeholder,
  d.effective_from,
  d.effective_to
from platform.website_domains d
join platform.websites w on w.id = d.website_id
join platform.tenants t on t.id = w.tenant_id
join platform.brands b on b.id = w.brand_id
left join platform.markets m on m.id = w.market_id
left join lateral (
  select lifecycle.to_status
  from platform.platform_lifecycle_events lifecycle
  where lifecycle.resource = 'domains'
    and lifecycle.record_id = d.id
  order by lifecycle.created_at desc, lifecycle.event_id desc
  limit 1
) d_lifecycle on true
left join lateral (
  select lifecycle.to_status
  from platform.platform_lifecycle_events lifecycle
  where lifecycle.resource = 'websites'
    and lifecycle.record_id = w.id
  order by lifecycle.created_at desc, lifecycle.event_id desc
  limit 1
) w_lifecycle on true
left join lateral (
  select lifecycle.to_status
  from platform.platform_lifecycle_events lifecycle
  where lifecycle.resource = 'tenants'
    and lifecycle.record_id = t.id
  order by lifecycle.created_at desc, lifecycle.event_id desc
  limit 1
) t_lifecycle on true
left join lateral (
  select lifecycle.to_status
  from platform.platform_lifecycle_events lifecycle
  where lifecycle.resource = 'brands'
    and lifecycle.record_id = b.id
  order by lifecycle.created_at desc, lifecycle.event_id desc
  limit 1
) b_lifecycle on true
left join lateral (
  select lifecycle.to_status
  from platform.platform_lifecycle_events lifecycle
  where lifecycle.resource = 'markets'
    and lifecycle.record_id = m.id
  order by lifecycle.created_at desc, lifecycle.event_id desc
  limit 1
) m_lifecycle on true
left join lateral (
  select cd.hostname
  from platform.website_domains cd
  left join lateral (
    select lifecycle.to_status
    from platform.platform_lifecycle_events lifecycle
    where lifecycle.resource = 'domains'
      and lifecycle.record_id = cd.id
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
where coalesce(d_lifecycle.to_status, d.status) = 'Active'
  and d.verification_status = 'Verified'
  and d.effective_from <= now()
  and (d.effective_to is null or d.effective_to > now())
  and coalesce(w_lifecycle.to_status, w.status) = 'Active'
  and coalesce(t_lifecycle.to_status, t.status) = 'Active'
  and coalesce(b_lifecycle.to_status, b.status) = 'Active'
  and (w.market_id is null or coalesce(m_lifecycle.to_status, m.status) = 'Active');

create or replace function platform.resolve_game_availability(
  p_tenant_id uuid,
  p_brand_id uuid,
  p_market_id uuid default null,
  p_website_id uuid default null,
  p_agent_id text default null,
  p_as_of timestamptz default now()
)
returns table (
  availability_id uuid,
  tenant_id uuid,
  brand_id uuid,
  market_id uuid,
  website_id uuid,
  agent_id text,
  game_id text,
  game_code text,
  game_manifest_reference text,
  status text,
  is_available boolean,
  specificity_rank integer,
  min_wager_override numeric(18, 2),
  max_wager_override numeric(18, 2),
  language_override text,
  currency_override text,
  timezone_override text,
  content_hash text
)
language sql
stable
as $$
  select distinct on (candidate.game_code)
    candidate.id as availability_id,
    candidate.tenant_id,
    candidate.brand_id,
    candidate.market_id,
    candidate.website_id,
    candidate.agent_id,
    candidate.game_id,
    candidate.game_code,
    candidate.game_manifest_reference,
    coalesce(lifecycle.to_status, candidate.status) as status,
    coalesce(lifecycle.to_status, candidate.status) = 'Active' as is_available,
    case
      when candidate.agent_id is not null then 5
      when candidate.website_id is not null then 4
      when candidate.market_id is not null then 3
      when candidate.brand_id is not null then 2
      else 1
    end as specificity_rank,
    candidate.min_wager_override,
    candidate.max_wager_override,
    candidate.language_override,
    candidate.currency_override,
    candidate.timezone_override,
    candidate.content_hash
  from platform.game_availability candidate
  left join lateral (
    select lifecycle.to_status
    from platform.platform_lifecycle_events lifecycle
    where lifecycle.resource = 'game-availability'
      and lifecycle.record_id = candidate.id
    order by lifecycle.created_at desc, lifecycle.event_id desc
    limit 1
  ) lifecycle on true
  where candidate.tenant_id = p_tenant_id
    and candidate.brand_id = p_brand_id
    and coalesce(lifecycle.to_status, candidate.status) in ('Active', 'Suspended', 'Retired')
    and candidate.effective_from <= p_as_of
    and (candidate.effective_to is null or candidate.effective_to > p_as_of)
    and (candidate.market_id is null or candidate.market_id = p_market_id)
    and (candidate.website_id is null or candidate.website_id = p_website_id)
    and (candidate.agent_id is null or candidate.agent_id = lower(btrim(p_agent_id)))
  order by
    candidate.game_code,
    case
      when candidate.agent_id is not null then 5
      when candidate.website_id is not null then 4
      when candidate.market_id is not null then 3
      when candidate.brand_id is not null then 2
      else 1
    end desc,
    candidate.effective_from desc,
    candidate.created_at desc;
$$;
