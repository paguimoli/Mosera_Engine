create schema if not exists platform;

create or replace function platform.validate_platform_website()
returns trigger
language plpgsql
as $$
declare
  brand_tenant_id uuid;
  market_brand_id uuid;
begin
  if btrim(new.website_code) = '' then
    raise exception 'website_code is required';
  end if;

  if btrim(new.display_name) = '' then
    raise exception 'website display_name is required';
  end if;

  if btrim(new.default_language) = '' then
    raise exception 'website default_language is required';
  end if;

  if btrim(new.default_currency) = '' then
    raise exception 'website default_currency is required';
  end if;

  if btrim(new.default_timezone) = '' then
    raise exception 'website default_timezone is required';
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

  if new.market_id is not null then
    select brand_id
    into market_brand_id
    from platform.markets
    where id = new.market_id;

    if market_brand_id is null then
      raise exception 'website market_id must reference an existing market when provided';
    end if;

    if market_brand_id <> new.brand_id then
      raise exception 'website market_id must belong to website brand_id';
    end if;
  end if;

  return new;
end;
$$;

create or replace function platform.validate_platform_website_domain()
returns trigger
language plpgsql
as $$
begin
  new.hostname := lower(btrim(new.hostname));

  if new.hostname = '' then
    raise exception 'domain hostname is required';
  end if;

  if new.hostname like 'http://%' or new.hostname like 'https://%' then
    raise exception 'domain hostname must not include a URL scheme';
  end if;

  if position('/' in new.hostname) > 0 then
    raise exception 'domain hostname must not include a path';
  end if;

  if btrim(new.verification_status) = '' then
    raise exception 'domain verification_status is required';
  end if;

  if btrim(new.version) = '' then
    raise exception 'domain version is required';
  end if;

  if new.content_hash !~ '^sha256:' then
    raise exception 'domain content_hash must use sha256 prefix';
  end if;

  if new.effective_to is not null and new.effective_to <= new.effective_from then
    raise exception 'domain effective_to must be after effective_from';
  end if;

  return new;
end;
$$;

create table if not exists platform.websites (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id),
  brand_id uuid not null references platform.brands(id),
  market_id uuid references platform.markets(id),
  website_code text not null,
  display_name text not null,
  status text not null,
  default_language text not null,
  default_currency text not null,
  default_timezone text not null,
  maintenance_mode boolean not null default false,
  future_theme_reference_placeholder jsonb not null default '{}'::jsonb,
  future_homepage_config_placeholder jsonb not null default '{}'::jsonb,
  version text not null,
  content_hash text not null,
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_platform_websites_status check (status in ('Draft', 'Active', 'Suspended', 'Retired')),
  constraint ck_platform_websites_code_trimmed check (website_code = lower(btrim(website_code))),
  constraint ux_platform_websites_brand_code unique (brand_id, website_code),
  constraint ux_platform_websites_content_hash unique (content_hash)
);

create table if not exists platform.website_domains (
  id uuid primary key,
  website_id uuid not null references platform.websites(id),
  hostname text not null,
  canonical boolean not null default false,
  status text not null,
  verification_status text not null,
  tls_mode_placeholder jsonb not null default '{}'::jsonb,
  cloudflare_proxy_metadata_placeholder jsonb not null default '{}'::jsonb,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  version text not null,
  content_hash text not null,
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_platform_website_domains_status check (status in ('PendingVerification', 'Active', 'Suspended', 'Retired')),
  constraint ck_platform_website_domains_hostname_trimmed check (hostname = lower(btrim(hostname))),
  constraint ux_platform_website_domains_hostname unique (hostname),
  constraint ux_platform_website_domains_content_hash unique (content_hash)
);

create unique index if not exists ux_platform_website_domains_canonical_website
  on platform.website_domains (website_id)
  where canonical = true;

create index if not exists idx_platform_websites_tenant_brand_market on platform.websites (tenant_id, brand_id, market_id);
create index if not exists idx_platform_websites_brand_code on platform.websites (brand_id, website_code);
create index if not exists idx_platform_websites_status on platform.websites (status);
create index if not exists idx_platform_websites_hash on platform.websites (content_hash);

create index if not exists idx_platform_website_domains_hostname on platform.website_domains (hostname);
create index if not exists idx_platform_website_domains_website_status on platform.website_domains (website_id, status);
create index if not exists idx_platform_website_domains_status on platform.website_domains (status);
create index if not exists idx_platform_website_domains_effective_window on platform.website_domains (effective_from, effective_to);
create index if not exists idx_platform_website_domains_hash on platform.website_domains (content_hash);

drop trigger if exists trg_validate_platform_website on platform.websites;
create trigger trg_validate_platform_website
before insert on platform.websites
for each row execute function platform.validate_platform_website();

drop trigger if exists trg_prevent_platform_website_update on platform.websites;
create trigger trg_prevent_platform_website_update
before update on platform.websites
for each row execute function platform.prevent_platform_foundation_update();

drop trigger if exists trg_prevent_platform_website_delete on platform.websites;
create trigger trg_prevent_platform_website_delete
before delete on platform.websites
for each row execute function platform.prevent_platform_foundation_delete();

drop trigger if exists trg_validate_platform_website_domain on platform.website_domains;
create trigger trg_validate_platform_website_domain
before insert on platform.website_domains
for each row execute function platform.validate_platform_website_domain();

drop trigger if exists trg_prevent_platform_website_domain_update on platform.website_domains;
create trigger trg_prevent_platform_website_domain_update
before update on platform.website_domains
for each row execute function platform.prevent_platform_foundation_update();

drop trigger if exists trg_prevent_platform_website_domain_delete on platform.website_domains;
create trigger trg_prevent_platform_website_domain_delete
before delete on platform.website_domains
for each row execute function platform.prevent_platform_foundation_delete();

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
  select cd.hostname
  from platform.website_domains cd
  where cd.website_id = w.id
    and cd.canonical = true
    and cd.status = 'Active'
    and cd.verification_status = 'Verified'
    and cd.effective_from <= now()
    and (cd.effective_to is null or cd.effective_to > now())
  order by cd.effective_from desc
  limit 1
) canonical_domain on true
where d.status = 'Active'
  and d.verification_status = 'Verified'
  and d.effective_from <= now()
  and (d.effective_to is null or d.effective_to > now())
  and w.status = 'Active'
  and t.status = 'Active'
  and b.status = 'Active'
  and (w.market_id is null or m.status = 'Active');
