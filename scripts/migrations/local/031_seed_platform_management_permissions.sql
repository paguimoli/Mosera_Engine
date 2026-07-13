create extension if not exists pgcrypto;

create or replace function auth_service.local_deterministic_uuid(input text)
returns uuid
language sql
immutable
as $$
  select (
    substr(md5(input), 1, 8) || '-' ||
    substr(md5(input), 9, 4) || '-' ||
    substr(md5(input), 13, 4) || '-' ||
    substr(md5(input), 17, 4) || '-' ||
    substr(md5(input), 21, 12)
  )::uuid;
$$;

with platform_permissions(code, display_name, description) as (
  values
    ('platform.organization.read', 'Platform Organization Read', 'Read platform owner organization records.'),
    ('platform.organization.create', 'Platform Organization Create', 'Create immutable platform owner organization versions.'),
    ('platform.tenant.read', 'Platform Tenant Read', 'Read tenant/operator platform records.'),
    ('platform.tenant.create', 'Platform Tenant Create', 'Create immutable tenant/operator platform versions.'),
    ('platform.brand.read', 'Platform Brand Read', 'Read brand platform records.'),
    ('platform.brand.create', 'Platform Brand Create', 'Create immutable brand platform versions.'),
    ('platform.market.read', 'Platform Market Read', 'Read market platform records.'),
    ('platform.market.create', 'Platform Market Create', 'Create immutable market platform versions.'),
    ('platform.website.read', 'Platform Website Read', 'Read website platform records.'),
    ('platform.website.create', 'Platform Website Create', 'Create immutable website platform versions.'),
    ('platform.domain.read', 'Platform Domain Read', 'Read website domain platform records.'),
    ('platform.domain.create', 'Platform Domain Create', 'Create immutable website domain platform versions.'),
    ('platform.theme.read', 'Platform Theme Read', 'Read brand theme platform records.'),
    ('platform.theme.create', 'Platform Theme Create', 'Create immutable brand theme platform versions.'),
    ('platform.asset.read', 'Platform Asset Read', 'Read brand asset reference records.'),
    ('platform.asset.create', 'Platform Asset Create', 'Create immutable brand asset reference versions.'),
    ('platform.game_availability.read', 'Platform Game Availability Read', 'Read game availability platform records.'),
    ('platform.game_availability.create', 'Platform Game Availability Create', 'Create immutable game availability versions.')
)
insert into auth_service.permissions (id, code, display_name, description)
select
  auth_service.local_deterministic_uuid('platform-management-permission:' || code),
  code,
  display_name,
  description
from platform_permissions
on conflict (code) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  disabled_at = null;

insert into auth_service.roles (id, code, display_name, system_role, metadata)
values
  (
    auth_service.local_deterministic_uuid('platform-management-role:PLATFORM_SUPER_ADMIN'),
    'PLATFORM_SUPER_ADMIN',
    'Super Admin',
    true,
    jsonb_build_object(
      'platformManagementRole', true,
      'scopeGovernance', 'GLOBAL',
      'permissions', (
        select jsonb_agg(code order by code)
        from auth_service.permissions
        where code like 'platform.%'
      )
    )
  ),
  (
    auth_service.local_deterministic_uuid('platform-management-role:PLATFORM_OPERATIONS_ADMIN'),
    'PLATFORM_OPERATIONS_ADMIN',
    'Operations Admin',
    false,
    jsonb_build_object(
      'platformManagementRole', true,
      'scopeGovernance', 'TENANT_BRAND_MARKET',
      'permissions', (
        select jsonb_agg(code order by code)
        from auth_service.permissions
        where code like 'platform.%'
          and code <> 'platform.organization.create'
      )
    )
  ),
  (
    auth_service.local_deterministic_uuid('platform-management-role:PLATFORM_READ_ONLY_AUDITOR'),
    'PLATFORM_READ_ONLY_AUDITOR',
    'Read Only Auditor',
    false,
    jsonb_build_object(
      'platformManagementRole', true,
      'scopeGovernance', 'READ_ONLY',
      'permissions', (
        select jsonb_agg(code order by code)
        from auth_service.permissions
        where code like 'platform.%.read'
      )
    )
  )
on conflict (code) do update set
  display_name = excluded.display_name,
  system_role = excluded.system_role,
  metadata = excluded.metadata,
  disabled_at = null;
