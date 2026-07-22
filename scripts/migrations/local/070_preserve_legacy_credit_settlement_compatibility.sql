alter table public.credit_reservations
  drop constraint if exists credit_reservations_status_check;

alter table public.credit_reservations
  add constraint credit_reservations_status_check check (
    (scope_model = 'CANONICAL' and status in (
      'RESERVED', 'PARTIALLY_RELEASED', 'PARTIALLY_CAPTURED',
      'RELEASED', 'CAPTURED', 'CANCELLED'
    ))
    or
    (scope_model = 'LEGACY' and status in (
      'RESERVED', 'PARTIALLY_RELEASED', 'PARTIALLY_CAPTURED',
      'RELEASED', 'CAPTURED', 'CANCELLED', 'SETTLED', 'FAILED'
    ))
  );

create or replace function credit_wallet_service.sync_legacy_reservation_capture()
returns trigger
language plpgsql
as $$
begin
  if old.scope_model = 'LEGACY' then
    new.captured_amount := new.settled_amount;
  end if;
  return new;
end;
$$;

drop trigger if exists credit_reservations_legacy_capture_sync
  on public.credit_reservations;
create trigger credit_reservations_legacy_capture_sync
before update on public.credit_reservations
for each row execute function credit_wallet_service.sync_legacy_reservation_capture();

comment on function credit_wallet_service.sync_legacy_reservation_capture() is
  'Compatibility adapter for the pre-canonical settlement RPC. Canonical reservations never accept legacy states or direct projection mutation.';
