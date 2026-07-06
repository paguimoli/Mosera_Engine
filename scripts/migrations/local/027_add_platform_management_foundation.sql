create schema if not exists platform;

create or replace function platform.prevent_platform_foundation_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'platform foundation rows are append-only and cannot be updated';
end;
$$;

create or replace function platform.prevent_platform_foundation_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'platform foundation rows are append-only and cannot be deleted';
end;
$$;

create or replace function platform.validate_platform_organization()
returns trigger
language plpgsql
as $$
begin
  if btrim(new.organization_code) = '' then
    raise exception 'organization_code is required';
  end if;

  if btrim(new.name) = '' then
    raise exception 'organization name is required';
  end if;

  if btrim(new.version) = '' then
    raise exception 'organization version is required';
  end if;

  if new.content_hash !~ '^sha256:' then
    raise exception 'organization content_hash must use sha256 prefix';
  end if;

  return new;
end;
$$;

create or replace function platform.validate_platform_tenant()
returns trigger
language plpgsql
as $$
begin
  if btrim(new.tenant_code) = '' then
    raise exception 'tenant_code is required';
  end if;

  if btrim(new.name) = '' then
    raise exception 'tenant name is required';
  end if;

  if btrim(new.default_language) = '' then
    raise exception 'tenant default_language is required';
  end if;

  if btrim(new.default_currency) = '' then
    raise exception 'tenant default_currency is required';
  end if;

  if btrim(new.default_timezone) = '' then
    raise exception 'tenant default_timezone is required';
  end if;

  if btrim(new.version) = '' then
    raise exception 'tenant version is required';
  end if;

  if new.content_hash !~ '^sha256:' then
    raise exception 'tenant content_hash must use sha256 prefix';
  end if;

  return new;
end;
$$;

create or replace function platform.validate_platform_brand()
returns trigger
language plpgsql
as $$
begin
  if btrim(new.brand_code) = '' then
    raise exception 'brand_code is required';
  end if;

  if btrim(new.name) = '' then
    raise exception 'brand name is required';
  end if;

  if btrim(new.display_name) = '' then
    raise exception 'brand display_name is required';
  end if;

  if btrim(new.version) = '' then
    raise exception 'brand version is required';
  end if;

  if new.content_hash !~ '^sha256:' then
    raise exception 'brand content_hash must use sha256 prefix';
  end if;

  return new;
end;
$$;

create or replace function platform.validate_platform_market()
returns trigger
language plpgsql
as $$
begin
  if btrim(new.market_code) = '' then
    raise exception 'market_code is required';
  end if;

  if btrim(new.name) = '' then
    raise exception 'market name is required';
  end if;

  if btrim(new.display_name) = '' then
    raise exception 'market display_name is required';
  end if;

  if btrim(new.language) = '' then
    raise exception 'market language is required';
  end if;

  if btrim(new.currency) = '' then
    raise exception 'market currency is required';
  end if;

  if btrim(new.timezone) = '' then
    raise exception 'market timezone is required';
  end if;

  if btrim(new.version) = '' then
    raise exception 'market version is required';
  end if;

  if new.content_hash !~ '^sha256:' then
    raise exception 'market content_hash must use sha256 prefix';
  end if;

  return new;
end;
$$;

create table if not exists platform.organizations (
  id uuid primary key,
  organization_code text not null,
  name text not null,
  status text not null,
  governance_metadata jsonb not null default '{}'::jsonb,
  global_defaults jsonb not null default '{}'::jsonb,
  version text not null,
  content_hash text not null,
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_platform_organizations_status check (status in ('Draft', 'Active', 'Suspended', 'Retired')),
  constraint ck_platform_organizations_code_trimmed check (organization_code = lower(btrim(organization_code))),
  constraint ux_platform_organizations_code_version unique (organization_code, version),
  constraint ux_platform_organizations_content_hash unique (content_hash)
);

create table if not exists platform.tenants (
  id uuid primary key,
  organization_id uuid not null references platform.organizations(id),
  tenant_code text not null,
  name text not null,
  status text not null,
  operator_metadata jsonb not null default '{}'::jsonb,
  default_language text not null,
  default_currency text not null,
  default_timezone text not null,
  credit_enabled boolean not null default true,
  cashier_enabled boolean not null default false,
  version text not null,
  content_hash text not null,
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_platform_tenants_status check (status in ('Draft', 'Active', 'Suspended', 'Retired')),
  constraint ck_platform_tenants_code_trimmed check (tenant_code = lower(btrim(tenant_code))),
  constraint ux_platform_tenants_parent_code_version unique (organization_id, tenant_code, version),
  constraint ux_platform_tenants_content_hash unique (content_hash)
);

create table if not exists platform.brands (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id),
  brand_code text not null,
  name text not null,
  display_name text not null,
  status text not null,
  theme_reference_placeholder jsonb not null default '{}'::jsonb,
  asset_reference_placeholder jsonb not null default '{}'::jsonb,
  website_reference_placeholder jsonb not null default '[]'::jsonb,
  version text not null,
  content_hash text not null,
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_platform_brands_status check (status in ('Draft', 'Active', 'Suspended', 'Retired')),
  constraint ck_platform_brands_code_trimmed check (brand_code = lower(btrim(brand_code))),
  constraint ux_platform_brands_parent_code_version unique (tenant_id, brand_code, version),
  constraint ux_platform_brands_content_hash unique (content_hash)
);

create table if not exists platform.markets (
  id uuid primary key,
  brand_id uuid not null references platform.brands(id),
  market_code text not null,
  name text not null,
  display_name text not null,
  country text,
  jurisdiction text,
  language text not null,
  currency text not null,
  timezone text not null,
  future_game_availability_placeholder jsonb not null default '{}'::jsonb,
  status text not null,
  version text not null,
  content_hash text not null,
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_platform_markets_status check (status in ('Draft', 'Active', 'Suspended', 'Retired')),
  constraint ck_platform_markets_code_trimmed check (market_code = lower(btrim(market_code))),
  constraint ux_platform_markets_parent_code_version unique (brand_id, market_code, version),
  constraint ux_platform_markets_content_hash unique (content_hash)
);

create index if not exists idx_platform_organizations_code on platform.organizations (organization_code);
create index if not exists idx_platform_organizations_status on platform.organizations (status);
create index if not exists idx_platform_organizations_hash on platform.organizations (content_hash);

create index if not exists idx_platform_tenants_parent_code on platform.tenants (organization_id, tenant_code);
create index if not exists idx_platform_tenants_status on platform.tenants (status);
create index if not exists idx_platform_tenants_hash on platform.tenants (content_hash);

create index if not exists idx_platform_brands_parent_code on platform.brands (tenant_id, brand_code);
create index if not exists idx_platform_brands_status on platform.brands (status);
create index if not exists idx_platform_brands_hash on platform.brands (content_hash);

create index if not exists idx_platform_markets_parent_code on platform.markets (brand_id, market_code);
create index if not exists idx_platform_markets_status on platform.markets (status);
create index if not exists idx_platform_markets_hash on platform.markets (content_hash);
create index if not exists idx_platform_markets_country_jurisdiction on platform.markets (country, jurisdiction);

drop trigger if exists trg_validate_platform_organization on platform.organizations;
create trigger trg_validate_platform_organization
before insert on platform.organizations
for each row execute function platform.validate_platform_organization();

drop trigger if exists trg_prevent_platform_organization_update on platform.organizations;
create trigger trg_prevent_platform_organization_update
before update on platform.organizations
for each row execute function platform.prevent_platform_foundation_update();

drop trigger if exists trg_prevent_platform_organization_delete on platform.organizations;
create trigger trg_prevent_platform_organization_delete
before delete on platform.organizations
for each row execute function platform.prevent_platform_foundation_delete();

drop trigger if exists trg_validate_platform_tenant on platform.tenants;
create trigger trg_validate_platform_tenant
before insert on platform.tenants
for each row execute function platform.validate_platform_tenant();

drop trigger if exists trg_prevent_platform_tenant_update on platform.tenants;
create trigger trg_prevent_platform_tenant_update
before update on platform.tenants
for each row execute function platform.prevent_platform_foundation_update();

drop trigger if exists trg_prevent_platform_tenant_delete on platform.tenants;
create trigger trg_prevent_platform_tenant_delete
before delete on platform.tenants
for each row execute function platform.prevent_platform_foundation_delete();

drop trigger if exists trg_validate_platform_brand on platform.brands;
create trigger trg_validate_platform_brand
before insert on platform.brands
for each row execute function platform.validate_platform_brand();

drop trigger if exists trg_prevent_platform_brand_update on platform.brands;
create trigger trg_prevent_platform_brand_update
before update on platform.brands
for each row execute function platform.prevent_platform_foundation_update();

drop trigger if exists trg_prevent_platform_brand_delete on platform.brands;
create trigger trg_prevent_platform_brand_delete
before delete on platform.brands
for each row execute function platform.prevent_platform_foundation_delete();

drop trigger if exists trg_validate_platform_market on platform.markets;
create trigger trg_validate_platform_market
before insert on platform.markets
for each row execute function platform.validate_platform_market();

drop trigger if exists trg_prevent_platform_market_update on platform.markets;
create trigger trg_prevent_platform_market_update
before update on platform.markets
for each row execute function platform.prevent_platform_foundation_update();

drop trigger if exists trg_prevent_platform_market_delete on platform.markets;
create trigger trg_prevent_platform_market_delete
before delete on platform.markets
for each row execute function platform.prevent_platform_foundation_delete();
