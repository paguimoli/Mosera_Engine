alter table public.platform_users
  drop constraint if exists platform_users_identity_class_check;

alter table public.platform_users
  add constraint platform_users_identity_class_check check (
    identity_class in (
      'PLATFORM_OPERATOR',
      'HIERARCHY_PARTICIPANT',
      'PLAYER',
      'SYSTEM_SERVICE',
      'BREAK_GLASS'
    )
  );

create or replace function public.prevent_break_glass_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Break-glass accounts cannot be deleted.';
end;
$$;

drop trigger if exists prevent_break_glass_delete
  on public.break_glass_accounts;

create trigger prevent_break_glass_delete
before delete on public.break_glass_accounts
for each row
execute function public.prevent_break_glass_delete();

create or replace function public.enforce_break_glass_account_limit()
returns trigger
language plpgsql
as $$
declare
  v_count integer;
begin
  select count(*)
    into v_count
  from public.break_glass_accounts
  where id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);

  if v_count >= 2 then
    raise exception 'Only two break-glass accounts are allowed.';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_break_glass_account_limit
  on public.break_glass_accounts;

create trigger enforce_break_glass_account_limit
before insert on public.break_glass_accounts
for each row
execute function public.enforce_break_glass_account_limit();
