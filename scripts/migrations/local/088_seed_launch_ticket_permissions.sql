create extension if not exists pgcrypto;

with ticket_permissions(code, display_name, description) as (
  values
    ('tickets.read', 'Ticket Read', 'Read canonical Tickets within the authenticated hierarchy scope.'),
    ('tickets.create', 'Ticket Create', 'Create canonical Tickets within the authenticated hierarchy scope.'),
    ('tickets.cancel', 'Ticket Cancel', 'Cancel eligible canonical Tickets within the authenticated hierarchy scope.')
)
insert into auth_service.permissions (id, code, display_name, description)
select
  auth_service.local_deterministic_uuid('launch-ticket-permission:' || code),
  code,
  display_name,
  description
from ticket_permissions
on conflict (code) do update set
  display_name = excluded.display_name,
  description = excluded.description,
  disabled_at = null;

with role_permission_assignments(role_code, permission_code) as (
  values
    ('PLATFORM_SUPER_ADMIN', 'tickets.read'),
    ('PLATFORM_SUPER_ADMIN', 'tickets.create'),
    ('PLATFORM_SUPER_ADMIN', 'tickets.cancel'),
    ('PLATFORM_OPERATIONS_ADMIN', 'tickets.read'),
    ('PLATFORM_OPERATIONS_ADMIN', 'tickets.create'),
    ('PLATFORM_OPERATIONS_ADMIN', 'tickets.cancel'),
    ('PLATFORM_READ_ONLY_AUDITOR', 'tickets.read')
),
resolved_permissions as (
  select
    role.code as role_code,
    jsonb_agg(distinct permission order by permission) as permissions
  from auth_service.roles role
  cross join lateral (
    select jsonb_array_elements_text(
      coalesce(role.metadata->'permissions', '[]'::jsonb)
    ) as permission
    union
    select assignment.permission_code
    from role_permission_assignments assignment
    where assignment.role_code = role.code
  ) combined
  where role.code in (
    'PLATFORM_SUPER_ADMIN',
    'PLATFORM_OPERATIONS_ADMIN',
    'PLATFORM_READ_ONLY_AUDITOR'
  )
  group by role.code
)
update auth_service.roles role
set metadata = jsonb_set(
  role.metadata,
  '{permissions}',
  resolved.permissions,
  true
)
from resolved_permissions resolved
where role.code = resolved.role_code;
