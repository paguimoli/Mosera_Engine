create schema if not exists platform;

create or replace function platform.validate_platform_brand_theme()
returns trigger
language plpgsql
as $$
declare
  brand_tenant_id uuid;
begin
  if btrim(new.theme_code) = '' then
    raise exception 'theme_code is required';
  end if;

  if btrim(new.display_name) = '' then
    raise exception 'theme display_name is required';
  end if;

  if btrim(new.version) = '' then
    raise exception 'theme version is required';
  end if;

  if new.content_hash !~ '^sha256:' then
    raise exception 'theme content_hash must use sha256 prefix';
  end if;

  select tenant_id
  into brand_tenant_id
  from platform.brands
  where id = new.brand_id;

  if brand_tenant_id is null then
    raise exception 'theme brand_id must reference an existing brand';
  end if;

  if brand_tenant_id <> new.tenant_id then
    raise exception 'theme tenant_id must match brand tenant_id';
  end if;

  if jsonb_typeof(new.color_tokens) <> 'object' then
    raise exception 'theme color_tokens must be a JSON object';
  end if;

  if jsonb_typeof(new.typography_tokens) <> 'object' then
    raise exception 'theme typography_tokens must be a JSON object';
  end if;

  if jsonb_typeof(new.spacing_radius_tokens) <> 'object' then
    raise exception 'theme spacing_radius_tokens must be a JSON object';
  end if;

  if jsonb_typeof(new.component_token_placeholders) <> 'object' then
    raise exception 'theme component_token_placeholders must be a JSON object';
  end if;

  if jsonb_typeof(new.mode_support) <> 'array' or jsonb_array_length(new.mode_support) = 0 then
    raise exception 'theme mode_support must be a non-empty JSON array';
  end if;

  return new;
end;
$$;

create or replace function platform.validate_platform_brand_asset()
returns trigger
language plpgsql
as $$
declare
  brand_tenant_id uuid;
begin
  if btrim(new.asset_key) = '' then
    raise exception 'asset_key is required';
  end if;

  if btrim(new.mime_type) = '' then
    raise exception 'asset mime_type is required';
  end if;

  if btrim(new.version) = '' then
    raise exception 'asset version is required';
  end if;

  if new.asset_checksum_hash !~ '^sha256:' then
    raise exception 'asset_checksum_hash must use sha256 prefix';
  end if;

  if new.content_hash !~ '^sha256:' then
    raise exception 'asset content_hash must use sha256 prefix';
  end if;

  select tenant_id
  into brand_tenant_id
  from platform.brands
  where id = new.brand_id;

  if brand_tenant_id is null then
    raise exception 'asset brand_id must reference an existing brand';
  end if;

  if brand_tenant_id <> new.tenant_id then
    raise exception 'asset tenant_id must match brand tenant_id';
  end if;

  if jsonb_typeof(new.storage_reference_placeholder) <> 'object' then
    raise exception 'asset storage_reference_placeholder must be a JSON object';
  end if;

  if new.storage_reference_placeholder ?| array['binary', 'binaryBlob', 'blob', 'base64', 'dataUri'] then
    raise exception 'asset storage_reference_placeholder must not contain inline binary data';
  end if;

  return new;
end;
$$;

create table if not exists platform.brand_themes (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id),
  brand_id uuid not null references platform.brands(id),
  theme_code text not null,
  display_name text not null,
  status text not null,
  is_default boolean not null default false,
  color_tokens jsonb not null default '{}'::jsonb,
  typography_tokens jsonb not null default '{}'::jsonb,
  spacing_radius_tokens jsonb not null default '{}'::jsonb,
  component_token_placeholders jsonb not null default '{}'::jsonb,
  mode_support jsonb not null default '["light"]'::jsonb,
  version text not null,
  content_hash text not null,
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_platform_brand_themes_status check (status in ('Draft', 'Active', 'Suspended', 'Retired')),
  constraint ck_platform_brand_themes_code_trimmed check (theme_code = lower(btrim(theme_code))),
  constraint ux_platform_brand_themes_brand_code unique (brand_id, theme_code),
  constraint ux_platform_brand_themes_content_hash unique (content_hash)
);

create table if not exists platform.brand_assets (
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id),
  brand_id uuid not null references platform.brands(id),
  asset_type text not null,
  asset_key text not null,
  storage_reference_placeholder jsonb not null default '{}'::jsonb,
  mime_type text not null,
  asset_checksum_hash text not null,
  status text not null,
  version text not null,
  content_hash text not null,
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_platform_brand_assets_type check (asset_type in ('LOGO', 'FAVICON', 'APP_ICON', 'EMAIL_HEADER', 'BACKGROUND', 'PROMOTIONAL')),
  constraint ck_platform_brand_assets_status check (status in ('Draft', 'Active', 'Suspended', 'Retired')),
  constraint ck_platform_brand_assets_key_trimmed check (asset_key = lower(btrim(asset_key))),
  constraint ux_platform_brand_assets_brand_type_key_version unique (brand_id, asset_type, asset_key, version),
  constraint ux_platform_brand_assets_content_hash unique (content_hash)
);

create unique index if not exists ux_platform_brand_themes_active_default_brand
  on platform.brand_themes (brand_id)
  where is_default = true and status = 'Active';

create index if not exists idx_platform_brand_themes_brand_status on platform.brand_themes (brand_id, status);
create index if not exists idx_platform_brand_themes_brand_code on platform.brand_themes (brand_id, theme_code);
create index if not exists idx_platform_brand_themes_tenant_brand on platform.brand_themes (tenant_id, brand_id);
create index if not exists idx_platform_brand_themes_hash on platform.brand_themes (content_hash);

create index if not exists idx_platform_brand_assets_brand_status on platform.brand_assets (brand_id, status);
create index if not exists idx_platform_brand_assets_brand_type on platform.brand_assets (brand_id, asset_type);
create index if not exists idx_platform_brand_assets_brand_type_key on platform.brand_assets (brand_id, asset_type, asset_key);
create index if not exists idx_platform_brand_assets_tenant_brand on platform.brand_assets (tenant_id, brand_id);
create index if not exists idx_platform_brand_assets_checksum on platform.brand_assets (asset_checksum_hash);
create index if not exists idx_platform_brand_assets_hash on platform.brand_assets (content_hash);

drop trigger if exists trg_validate_platform_brand_theme on platform.brand_themes;
create trigger trg_validate_platform_brand_theme
before insert on platform.brand_themes
for each row execute function platform.validate_platform_brand_theme();

drop trigger if exists trg_prevent_platform_brand_theme_update on platform.brand_themes;
create trigger trg_prevent_platform_brand_theme_update
before update on platform.brand_themes
for each row execute function platform.prevent_platform_foundation_update();

drop trigger if exists trg_prevent_platform_brand_theme_delete on platform.brand_themes;
create trigger trg_prevent_platform_brand_theme_delete
before delete on platform.brand_themes
for each row execute function platform.prevent_platform_foundation_delete();

drop trigger if exists trg_validate_platform_brand_asset on platform.brand_assets;
create trigger trg_validate_platform_brand_asset
before insert on platform.brand_assets
for each row execute function platform.validate_platform_brand_asset();

drop trigger if exists trg_prevent_platform_brand_asset_update on platform.brand_assets;
create trigger trg_prevent_platform_brand_asset_update
before update on platform.brand_assets
for each row execute function platform.prevent_platform_foundation_update();

drop trigger if exists trg_prevent_platform_brand_asset_delete on platform.brand_assets;
create trigger trg_prevent_platform_brand_asset_delete
before delete on platform.brand_assets
for each row execute function platform.prevent_platform_foundation_delete();
