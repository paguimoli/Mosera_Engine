create table if not exists public.permissions (
  id uuid primary key default gen_random_uuid(),
  permission_key text not null unique,
  description text,
  category text,
  is_system_permission boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_group_permissions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.user_groups(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint user_group_permissions_group_permission_unique unique (
    group_id,
    permission_id
  )
);

drop trigger if exists set_permissions_updated_at on public.permissions;
create trigger set_permissions_updated_at
before update on public.permissions
for each row execute function public.set_updated_at();

create index if not exists permissions_permission_key_idx
  on public.permissions(permission_key);
create index if not exists permissions_category_idx
  on public.permissions(category);
create index if not exists user_group_permissions_group_id_idx
  on public.user_group_permissions(group_id);
create index if not exists user_group_permissions_permission_id_idx
  on public.user_group_permissions(permission_id);

alter table public.permissions enable row level security;
alter table public.user_group_permissions enable row level security;

insert into public.permissions (
  permission_key,
  description,
  category,
  is_system_permission
)
values
  ('system.admin', 'Full system administration access.', 'system', true),
  ('auth.users.view', 'View authentication users.', 'auth', true),
  ('auth.users.create', 'Create authentication users.', 'auth', true),
  ('auth.users.edit', 'Edit authentication users.', 'auth', true),
  ('auth.users.disable', 'Disable authentication users.', 'auth', true),
  ('auth.sessions.view', 'View authentication sessions.', 'auth', true),
  ('auth.sessions.revoke', 'Revoke authentication sessions.', 'auth', true),
  ('accounts.view', 'View accounts.', 'accounts', true),
  ('accounts.create', 'Create accounts.', 'accounts', true),
  ('accounts.edit', 'Edit accounts.', 'accounts', true),
  ('accounts.disable', 'Disable accounts.', 'accounts', true),
  ('accounts.reassign', 'Reassign accounts.', 'accounts', true),
  ('agents.view', 'View agents.', 'agents', true),
  ('agents.create', 'Create agents.', 'agents', true),
  ('agents.edit', 'Edit agents.', 'agents', true),
  ('agents.disable', 'Disable agents.', 'agents', true),
  ('players.view', 'View players.', 'players', true),
  ('players.create', 'Create players.', 'players', true),
  ('players.edit', 'Edit players.', 'players', true),
  ('players.disable', 'Disable players.', 'players', true),
  ('markets.view', 'View markets.', 'markets', true),
  ('markets.create', 'Create markets.', 'markets', true),
  ('markets.edit', 'Edit markets.', 'markets', true),
  ('markets.disable', 'Disable markets.', 'markets', true),
  ('games.view', 'View games.', 'games', true),
  ('games.create', 'Create games.', 'games', true),
  ('games.edit', 'Edit games.', 'games', true),
  ('games.disable', 'Disable games.', 'games', true),
  ('drawings.view', 'View drawings.', 'drawings', true),
  ('drawings.create', 'Create drawings.', 'drawings', true),
  ('drawings.edit', 'Edit drawings.', 'drawings', true),
  ('drawings.close', 'Close drawings.', 'drawings', true),
  ('drawings.results_post', 'Post drawing results.', 'drawings', true),
  ('drawings.settle', 'Settle drawings.', 'drawings', true),
  ('tickets.view', 'View tickets.', 'tickets', true),
  ('tickets.create', 'Create tickets.', 'tickets', true),
  ('tickets.cancel', 'Cancel tickets.', 'tickets', true),
  ('tickets.settle', 'Settle tickets.', 'tickets', true),
  ('ledger.view', 'View ledger.', 'ledger', true),
  ('ledger.post_adjustment', 'Post ledger adjustments.', 'ledger', true),
  ('ledger.post_deposit', 'Post ledger deposits.', 'ledger', true),
  ('ledger.post_withdrawal', 'Post ledger withdrawals.', 'ledger', true),
  ('reports.view', 'View reports.', 'reports', true),
  ('reports.export', 'Export reports.', 'reports', true),
  ('settings.view', 'View settings.', 'settings', true),
  ('settings.edit', 'Edit settings.', 'settings', true),
  ('audit.view', 'View audit records.', 'audit', true)
on conflict (permission_key) do update
set
  description = excluded.description,
  category = excluded.category,
  is_system_permission = excluded.is_system_permission,
  updated_at = now();

insert into public.user_group_permissions (group_id, permission_id)
select
  user_groups.id,
  permissions.id
from public.user_groups
cross join public.permissions
where user_groups.name = 'Super Admin'
on conflict (group_id, permission_id) do nothing;
