alter table public.credit_reservations
  add column if not exists wallet_id uuid references public.financial_wallets(id),
  add column if not exists tenant_id uuid references platform.tenants(id),
  add column if not exists brand_id uuid references platform.brands(id),
  add column if not exists instrument_code text references credit_wallet_service.wallet_instrument_definitions(instrument_code),
  add column if not exists captured_amount bigint not null default 0,
  add column if not exists scope_model text not null default 'LEGACY',
  add column if not exists completed_at timestamptz;

update public.credit_reservations
set captured_amount = settled_amount
where captured_amount <> settled_amount;

alter table public.credit_reservations
  drop constraint if exists credit_reservations_status_check,
  drop constraint if exists credit_reservations_exposure_equation,
  drop constraint if exists credit_reservations_component_bounds;

do $$
declare v_constraint text;
begin
  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.credit_reservations'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%PARTIALLY_RELEASED%'
  loop
    execute format('alter table public.credit_reservations drop constraint %I', v_constraint);
  end loop;
end;
$$;

update public.credit_reservations
set status = case
      when status = 'SETTLED' then 'CAPTURED'
      when status = 'PARTIALLY_RELEASED' and settled_amount > 0 then 'PARTIALLY_CAPTURED'
      else status
    end,
    completed_at = case when status in ('SETTLED', 'RELEASED', 'CANCELLED')
      then coalesce(settled_at, released_at, cancelled_at, updated_at) else completed_at end
where status = 'SETTLED'
   or (status = 'PARTIALLY_RELEASED' and settled_amount > 0)
   or status in ('RELEASED', 'CANCELLED');

alter table public.credit_reservations
  add constraint credit_reservations_status_check
    check (status in ('RESERVED', 'PARTIALLY_RELEASED', 'PARTIALLY_CAPTURED', 'RELEASED', 'CAPTURED', 'CANCELLED')),
  add constraint credit_reservations_scope_model_check
    check (scope_model in ('LEGACY', 'CANONICAL')),
  add constraint credit_reservations_canonical_scope_check
    check (scope_model = 'LEGACY' or
      (wallet_id is not null and tenant_id is not null and brand_id is not null and instrument_code is not null)),
  add constraint credit_reservations_component_bounds
    check (reserved_amount >= 0 and released_amount >= 0 and captured_amount >= 0 and remaining_exposure >= 0),
  add constraint credit_reservations_capture_compatibility_check
    check (settled_amount = captured_amount),
  add constraint credit_reservations_exposure_equation
    check (released_amount + captured_amount + remaining_exposure = reserved_amount),
  add constraint credit_reservations_terminal_remaining_check
    check (status not in ('RELEASED', 'CAPTURED', 'CANCELLED') or remaining_exposure = 0);

create unique index if not exists ux_credit_reservations_canonical_business_reference
  on public.credit_reservations(wallet_id, ticket_id, instrument_code)
  where scope_model = 'CANONICAL';
create index if not exists idx_credit_reservations_canonical_exposure
  on public.credit_reservations(player_id, instrument_code, wallet_id, status)
  where scope_model = 'CANONICAL';

alter table public.credit_reservation_releases
  add column if not exists operation_id uuid references credit_wallet_service.wallet_operation_requests(operation_id),
  add column if not exists release_type text not null default 'RELEASE';
alter table public.credit_reservation_releases
  add constraint credit_reservation_releases_type_check check (release_type in ('RELEASE', 'CANCEL'));
create unique index if not exists ux_credit_reservation_releases_operation
  on public.credit_reservation_releases(operation_id) where operation_id is not null;

alter table public.credit_settlement_applications
  add column if not exists operation_id uuid references credit_wallet_service.wallet_operation_requests(operation_id),
  add column if not exists source_authority text,
  add column if not exists settlement_instruction_id text,
  add column if not exists settlement_instruction_sequence bigint,
  add column if not exists settlement_instruction_hash text,
  add column if not exists wallet_id uuid references public.financial_wallets(id),
  add column if not exists instrument_code text references credit_wallet_service.wallet_instrument_definitions(instrument_code);

drop trigger if exists credit_settlement_applications_update_guard
  on public.credit_settlement_applications;
update public.credit_settlement_applications
set source_authority = coalesce(source_authority, 'LEGACY'),
    settlement_instruction_id = coalesce(settlement_instruction_id, settlement_id),
    settlement_instruction_sequence = coalesce(settlement_instruction_sequence, 0),
    settlement_instruction_hash = coalesce(
      settlement_instruction_hash,
      'sha256:' || encode(digest(
        concat_ws('|', settlement_id, reservation_id::text, release_amount::text,
          balance_impact::text, currency, operation_type), 'sha256'), 'hex'))
where source_authority is null
   or settlement_instruction_id is null
   or settlement_instruction_sequence is null
   or settlement_instruction_hash is null;

alter table public.credit_settlement_applications
  alter column source_authority set not null,
  alter column settlement_instruction_id set not null,
  alter column settlement_instruction_sequence set not null,
  alter column settlement_instruction_hash set not null;

alter table public.credit_settlement_applications
  drop constraint if exists credit_settlement_applications_operation_type_check;
do $$
declare v_constraint text;
begin
  for v_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.credit_settlement_applications'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%PARTIAL_SETTLEMENT%'
  loop
    execute format('alter table public.credit_settlement_applications drop constraint %I', v_constraint);
  end loop;
end;
$$;
alter table public.credit_settlement_applications
  add constraint credit_settlement_applications_operation_type_check
    check (operation_type in ('PARTIAL_SETTLEMENT', 'FULL_SETTLEMENT', 'PARTIAL_CAPTURE', 'FULL_CAPTURE')),
  add constraint credit_settlement_applications_instruction_hash_check
    check (settlement_instruction_hash ~ '^sha256:[0-9a-f]{64}$');
create unique index if not exists ux_credit_settlement_authoritative_instruction
  on public.credit_settlement_applications(
    source_authority, settlement_id, settlement_instruction_id,
    settlement_instruction_sequence, reservation_id, operation_type);
create unique index if not exists ux_credit_settlement_operation
  on public.credit_settlement_applications(operation_id) where operation_id is not null;

create table credit_wallet_service.wallet_reservation_cancellations (
  cancellation_id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique references credit_wallet_service.wallet_operation_requests(operation_id),
  reservation_id uuid not null references public.credit_reservations(id),
  released_amount bigint not null check (released_amount > 0),
  reason_code text not null check (btrim(reason_code) <> ''),
  correlation_id text not null,
  evidence_hash text not null unique check (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index idx_wallet_reservation_cancellations_reservation
  on credit_wallet_service.wallet_reservation_cancellations(reservation_id, created_at);
create trigger wallet_reservation_cancellations_update_guard before update
  on credit_wallet_service.wallet_reservation_cancellations
  for each row execute function credit_wallet_service.prevent_evidence_mutation();
create trigger wallet_reservation_cancellations_delete_guard before delete
  on credit_wallet_service.wallet_reservation_cancellations
  for each row execute function credit_wallet_service.prevent_evidence_mutation();

alter table credit_wallet_service.wallet_operation_requests
  add column if not exists settlement_instruction_id uuid,
  add column if not exists settlement_instruction_sequence bigint;
alter table credit_wallet_service.wallet_operation_requests
  drop constraint if exists wallet_operation_requests_operation_type_check;
alter table credit_wallet_service.wallet_operation_requests
  add constraint wallet_operation_requests_operation_type_check
    check (operation_type in ('ISSUE', 'RESERVE', 'RELEASE', 'CANCEL', 'SETTLE', 'REVERSE', 'EXPIRE'));

create or replace function credit_wallet_service.guard_canonical_reservation_projection()
returns trigger language plpgsql as $$
begin
  if old.scope_model = 'CANONICAL'
     and current_setting('credit_wallet_service.projection_mutation', true) <> 'approved' then
    raise exception 'Canonical reservation projection may only be changed by approved Credit Wallet functions.';
  end if;
  if row(new.player_id, new.wallet_id, new.tenant_id, new.brand_id, new.instrument_code, new.currency,
         new.reserved_amount, new.ticket_id, new.scope_model)
     is distinct from
     row(old.player_id, old.wallet_id, old.tenant_id, old.brand_id, old.instrument_code, old.currency,
         old.reserved_amount, old.ticket_id, old.scope_model) then
    raise exception 'Canonical reservation identity and scope are immutable.';
  end if;
  return new;
end;
$$;
create trigger credit_reservations_canonical_projection_guard
before update on public.credit_reservations
for each row execute function credit_wallet_service.guard_canonical_reservation_projection();

create or replace function credit_wallet_service.assert_wallet_scope(
  p_wallet_id uuid, p_tenant_id uuid, p_brand_id uuid, p_player_id uuid,
  p_instrument text, p_currency text
) returns public.financial_wallets language plpgsql as $$
declare v_wallet public.financial_wallets%rowtype; v_scope credit_wallet_service.wallet_scopes%rowtype;
begin
  select * into v_wallet from public.financial_wallets where id = p_wallet_id for update;
  if not found then raise exception 'Wallet was not found.'; end if;
  select * into v_scope from credit_wallet_service.wallet_scopes where wallet_id = p_wallet_id;
  if not found or row(v_scope.tenant_id, v_scope.brand_id, v_scope.player_id, v_scope.instrument_code, v_scope.currency)
    is distinct from row(p_tenant_id, p_brand_id, p_player_id, p_instrument, p_currency) then
    raise exception 'Wallet operation scope does not match the authoritative wallet scope.';
  end if;
  if row(v_wallet.account_id, v_wallet.wallet_type, v_wallet.currency_code)
    is distinct from row(p_player_id, p_instrument, p_currency) then
    raise exception 'Wallet projection does not match the canonical operation scope.';
  end if;
  if v_wallet.status not in ('ACTIVE', 'SUSPENDED', 'CLOSED') then
    raise exception 'Wallet has an unsupported operational status.';
  end if;
  return v_wallet;
end;
$$;

create or replace function credit_wallet_service.reserve_wallet(
  p_operation_id uuid, p_wallet_id uuid, p_tenant_id uuid, p_brand_id uuid, p_player_id uuid,
  p_instrument text, p_ticket_id text, p_amount bigint, p_currency text,
  p_idempotency_key text, p_correlation_id text, p_metadata jsonb
) returns jsonb language plpgsql as $$
declare
  v_wallet public.financial_wallets%rowtype;
  v_instrument credit_wallet_service.wallet_instrument_definitions%rowtype;
  v_existing public.credit_reservations%rowtype;
  v_exposure bigint; v_available bigint; v_reservation public.credit_reservations%rowtype;
begin
  v_wallet := credit_wallet_service.assert_wallet_scope(
    p_wallet_id, p_tenant_id, p_brand_id, p_player_id, p_instrument, p_currency);
  if v_wallet.status <> 'ACTIVE' then raise exception 'Wallet status does not permit a new reservation.'; end if;
  select * into v_instrument from credit_wallet_service.wallet_instrument_definitions
    where instrument_code = p_instrument and lifecycle_state = 'ACTIVE';
  if not found or not v_instrument.reservable then raise exception 'Wallet instrument is not reservable.'; end if;
  if p_amount <= 0 then raise exception 'Reservation amount must be positive.'; end if;

  select * into v_existing from public.credit_reservations
    where wallet_id = p_wallet_id and ticket_id = p_ticket_id and instrument_code = p_instrument;
  if found then raise exception 'Reservation business reference already exists.'; end if;

  select coalesce(sum(remaining_exposure), 0)::bigint into v_exposure
    from public.credit_reservations
    where wallet_id = p_wallet_id and remaining_exposure > 0;
  v_available := case when p_instrument = 'CREDIT'
    then coalesce(v_wallet.credit_limit, 0)::bigint + coalesce(v_wallet.balance, 0)::bigint - v_exposure
    else coalesce(v_wallet.balance, 0)::bigint - v_exposure end;
  if v_available < p_amount then raise exception 'Insufficient available operational balance.'; end if;

  perform set_config('credit_wallet_service.canonical_insert', 'approved', true);
  insert into public.credit_reservations(
    player_id, wallet_id, tenant_id, brand_id, instrument_code, scope_model,
    ticket_id, amount, currency, status, reserved_amount, released_amount,
    settled_amount, captured_amount, remaining_exposure, idempotency_key,
    correlation_id, metadata)
  values (p_player_id, p_wallet_id, p_tenant_id, p_brand_id, p_instrument, 'CANONICAL',
    p_ticket_id, p_amount, p_currency, 'RESERVED', p_amount, 0, 0, 0, p_amount,
    p_idempotency_key, p_correlation_id, coalesce(p_metadata, '{}'::jsonb))
  returning * into v_reservation;

  insert into public.outbox_events(event_type, aggregate_type, aggregate_id, payload, status, correlation_id)
  values ('wallet.reservation.created', 'credit_reservation', v_reservation.id::text,
    jsonb_build_object('operationId', p_operation_id, 'reservationId', v_reservation.id,
      'walletId', p_wallet_id, 'playerId', p_player_id, 'instrument', p_instrument,
      'reservedAmount', p_amount, 'currency', p_currency), 'PENDING', p_correlation_id);
  return to_jsonb(v_reservation);
end;
$$;

create or replace function credit_wallet_service.release_wallet_reservation(
  p_operation_id uuid, p_reservation_id uuid, p_wallet_id uuid, p_tenant_id uuid,
  p_brand_id uuid, p_player_id uuid, p_instrument text, p_ticket_id text,
  p_release_amount bigint, p_currency text, p_idempotency_key text,
  p_correlation_id text, p_reason text, p_metadata jsonb
) returns jsonb language plpgsql as $$
declare v_wallet public.financial_wallets%rowtype; v_reservation public.credit_reservations%rowtype;
  v_remaining bigint; v_status text;
begin
  v_wallet := credit_wallet_service.assert_wallet_scope(
    p_wallet_id, p_tenant_id, p_brand_id, p_player_id, p_instrument, p_currency);
  select * into v_reservation from public.credit_reservations where id = p_reservation_id for update;
  if not found then raise exception 'Reservation was not found.'; end if;
  if row(v_reservation.wallet_id, v_reservation.tenant_id, v_reservation.brand_id,
         v_reservation.player_id, v_reservation.instrument_code, v_reservation.currency, v_reservation.ticket_id)
     is distinct from row(p_wallet_id, p_tenant_id, p_brand_id, p_player_id, p_instrument, p_currency, p_ticket_id)
    then raise exception 'Release scope does not match reservation.'; end if;
  if v_reservation.status not in ('RESERVED', 'PARTIALLY_RELEASED', 'PARTIALLY_CAPTURED')
    then raise exception 'Terminal reservation cannot be released.'; end if;
  if p_release_amount <= 0 or p_release_amount > v_reservation.remaining_exposure
    then raise exception 'Release amount exceeds remaining exposure.'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'Release reason is required.'; end if;

  insert into public.credit_reservation_releases(
    reservation_id, ticket_id, release_amount, idempotency_key, correlation_id,
    reason, metadata, operation_id, release_type)
  values (p_reservation_id, p_ticket_id, p_release_amount, p_idempotency_key,
    p_correlation_id, p_reason, coalesce(p_metadata, '{}'::jsonb), p_operation_id, 'RELEASE');
  v_remaining := v_reservation.remaining_exposure - p_release_amount;
  v_status := case when v_remaining = 0 then 'RELEASED'
    when v_reservation.captured_amount > 0 then 'PARTIALLY_CAPTURED'
    else 'PARTIALLY_RELEASED' end;
  perform set_config('credit_wallet_service.projection_mutation', 'approved', true);
  update public.credit_reservations set released_amount = released_amount + p_release_amount,
    remaining_exposure = v_remaining, status = v_status,
    released_at = case when v_remaining = 0 then now() else released_at end,
    completed_at = case when v_remaining = 0 then now() else completed_at end
  where id = p_reservation_id returning * into v_reservation;
  insert into public.outbox_events(event_type, aggregate_type, aggregate_id, payload, status, correlation_id)
  values ('wallet.reservation.released', 'credit_reservation', p_reservation_id::text,
    jsonb_build_object('operationId', p_operation_id, 'reservationId', p_reservation_id,
      'releasedAmount', p_release_amount, 'remainingExposure', v_remaining,
      'status', v_status), 'PENDING', p_correlation_id);
  return to_jsonb(v_reservation);
end;
$$;

create or replace function credit_wallet_service.cancel_wallet_reservation(
  p_operation_id uuid, p_reservation_id uuid, p_wallet_id uuid, p_tenant_id uuid,
  p_brand_id uuid, p_player_id uuid, p_instrument text, p_ticket_id text,
  p_expected_remaining bigint, p_currency text, p_idempotency_key text,
  p_correlation_id text, p_reason text, p_metadata jsonb
) returns jsonb language plpgsql as $$
declare v_wallet public.financial_wallets%rowtype; v_reservation public.credit_reservations%rowtype;
  v_hash text;
begin
  v_wallet := credit_wallet_service.assert_wallet_scope(
    p_wallet_id, p_tenant_id, p_brand_id, p_player_id, p_instrument, p_currency);
  select * into v_reservation from public.credit_reservations where id = p_reservation_id for update;
  if not found then raise exception 'Reservation was not found.'; end if;
  if row(v_reservation.wallet_id, v_reservation.tenant_id, v_reservation.brand_id,
         v_reservation.player_id, v_reservation.instrument_code, v_reservation.currency, v_reservation.ticket_id)
     is distinct from row(p_wallet_id, p_tenant_id, p_brand_id, p_player_id, p_instrument, p_currency, p_ticket_id)
    then raise exception 'Cancellation scope does not match reservation.'; end if;
  if v_reservation.status not in ('RESERVED', 'PARTIALLY_RELEASED', 'PARTIALLY_CAPTURED')
    then raise exception 'Terminal reservation cannot be cancelled.'; end if;
  if v_reservation.remaining_exposure <= 0 or p_expected_remaining <> v_reservation.remaining_exposure
    then raise exception 'Cancellation remaining exposure does not match request.'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'Cancellation reason is required.'; end if;
  v_hash := 'sha256:' || encode(digest(concat_ws('|', p_operation_id::text,
    p_reservation_id::text, v_reservation.remaining_exposure::text, p_reason), 'sha256'), 'hex');
  insert into public.credit_reservation_releases(
    reservation_id, ticket_id, release_amount, idempotency_key, correlation_id,
    reason, metadata, operation_id, release_type)
  values (p_reservation_id, p_ticket_id, v_reservation.remaining_exposure,
    p_idempotency_key, p_correlation_id, p_reason, coalesce(p_metadata, '{}'::jsonb),
    p_operation_id, 'CANCEL');
  insert into credit_wallet_service.wallet_reservation_cancellations(
    operation_id, reservation_id, released_amount, reason_code, correlation_id,
    evidence_hash, audit_metadata)
  values (p_operation_id, p_reservation_id, v_reservation.remaining_exposure,
    p_reason, p_correlation_id, v_hash, coalesce(p_metadata, '{}'::jsonb));
  perform set_config('credit_wallet_service.projection_mutation', 'approved', true);
  update public.credit_reservations set released_amount = released_amount + remaining_exposure,
    remaining_exposure = 0, status = 'CANCELLED', cancelled_at = now(), completed_at = now()
  where id = p_reservation_id returning * into v_reservation;
  insert into public.outbox_events(event_type, aggregate_type, aggregate_id, payload, status, correlation_id)
  values ('wallet.reservation.cancelled', 'credit_reservation', p_reservation_id::text,
    jsonb_build_object('operationId', p_operation_id, 'reservationId', p_reservation_id,
      'releasedAmount', v_reservation.released_amount, 'status', 'CANCELLED'),
    'PENDING', p_correlation_id);
  return to_jsonb(v_reservation);
end;
$$;

create or replace function credit_wallet_service.capture_wallet_reservation(
  p_operation_id uuid, p_reservation_id uuid, p_wallet_id uuid, p_tenant_id uuid,
  p_brand_id uuid, p_player_id uuid, p_instrument text, p_ticket_id text,
  p_settlement_id text, p_instruction_id text, p_instruction_sequence bigint,
  p_capture_amount bigint, p_balance_impact bigint, p_currency text,
  p_source_authority text, p_instruction_hash text, p_idempotency_key text,
  p_correlation_id text, p_metadata jsonb
) returns jsonb language plpgsql as $$
declare v_wallet public.financial_wallets%rowtype; v_reservation public.credit_reservations%rowtype;
  v_existing public.credit_settlement_applications%rowtype; v_application public.credit_settlement_applications%rowtype;
  v_remaining bigint; v_status text; v_balance_before bigint; v_balance_after bigint; v_operation text;
begin
  v_wallet := credit_wallet_service.assert_wallet_scope(
    p_wallet_id, p_tenant_id, p_brand_id, p_player_id, p_instrument, p_currency);
  if v_wallet.status = 'CLOSED' then raise exception 'Closed wallet cannot apply capture.'; end if;
  select * into v_existing from public.credit_settlement_applications
   where source_authority = p_source_authority and settlement_id = p_settlement_id
     and settlement_instruction_id = p_instruction_id
     and settlement_instruction_sequence = p_instruction_sequence
     and reservation_id = p_reservation_id
     and operation_type in ('PARTIAL_CAPTURE', 'FULL_CAPTURE');
  if found then
    if v_existing.settlement_instruction_hash <> p_instruction_hash then
      raise exception 'Authoritative settlement instruction conflicts with committed capture.';
    end if;
    return to_jsonb(v_existing);
  end if;
  select * into v_reservation from public.credit_reservations where id = p_reservation_id for update;
  if not found then raise exception 'Reservation was not found.'; end if;
  select * into v_existing from public.credit_settlement_applications
   where source_authority = p_source_authority and settlement_id = p_settlement_id
     and settlement_instruction_id = p_instruction_id
     and settlement_instruction_sequence = p_instruction_sequence
     and reservation_id = p_reservation_id
     and operation_type in ('PARTIAL_CAPTURE', 'FULL_CAPTURE');
  if found then
    if v_existing.settlement_instruction_hash <> p_instruction_hash then
      raise exception 'Authoritative settlement instruction conflicts with committed capture.';
    end if;
    return to_jsonb(v_existing);
  end if;
  if row(v_reservation.wallet_id, v_reservation.tenant_id, v_reservation.brand_id,
         v_reservation.player_id, v_reservation.instrument_code, v_reservation.currency, v_reservation.ticket_id)
     is distinct from row(p_wallet_id, p_tenant_id, p_brand_id, p_player_id, p_instrument, p_currency, p_ticket_id)
    then raise exception 'Capture scope does not match reservation.'; end if;
  if v_reservation.status not in ('RESERVED', 'PARTIALLY_RELEASED', 'PARTIALLY_CAPTURED')
    then raise exception 'Terminal reservation cannot be captured.'; end if;
  if p_capture_amount <= 0 or p_capture_amount > v_reservation.remaining_exposure
    then raise exception 'Capture amount exceeds remaining exposure.'; end if;
  if p_instruction_id is null or btrim(p_instruction_id) = '' or p_instruction_sequence < 0
    then raise exception 'Authoritative settlement instruction identity is required.'; end if;
  v_remaining := v_reservation.remaining_exposure - p_capture_amount;
  v_status := case when v_remaining = 0 then 'CAPTURED' else 'PARTIALLY_CAPTURED' end;
  v_operation := case when v_remaining = 0 then 'FULL_CAPTURE' else 'PARTIAL_CAPTURE' end;
  v_balance_before := coalesce(v_wallet.balance, 0)::bigint;
  v_balance_after := v_balance_before + p_balance_impact;
  update public.financial_wallets set balance = v_balance_after where id = p_wallet_id;
  insert into public.credit_settlement_applications(
    reservation_id, player_id, ticket_id, settlement_id, release_amount,
    balance_impact, balance_before, balance_after, currency, operation_type,
    idempotency_key, correlation_id, metadata, operation_id, source_authority,
    settlement_instruction_id, settlement_instruction_sequence,
    settlement_instruction_hash, wallet_id, instrument_code)
  values (p_reservation_id, p_player_id, p_ticket_id, p_settlement_id, p_capture_amount,
    p_balance_impact, v_balance_before, v_balance_after, p_currency, v_operation,
    p_idempotency_key, p_correlation_id, coalesce(p_metadata, '{}'::jsonb), p_operation_id,
    p_source_authority, p_instruction_id, p_instruction_sequence, p_instruction_hash,
    p_wallet_id, p_instrument)
  returning * into v_application;
  perform set_config('credit_wallet_service.projection_mutation', 'approved', true);
  update public.credit_reservations set captured_amount = captured_amount + p_capture_amount,
    settled_amount = settled_amount + p_capture_amount, remaining_exposure = v_remaining,
    status = v_status, settled_at = case when v_remaining = 0 then now() else settled_at end,
    completed_at = case when v_remaining = 0 then now() else completed_at end
  where id = p_reservation_id;
  insert into public.outbox_events(event_type, aggregate_type, aggregate_id, payload, status, correlation_id)
  values ('wallet.reservation.captured', 'credit_settlement_application', v_application.id::text,
    jsonb_build_object('operationId', p_operation_id, 'reservationId', p_reservation_id,
      'settlementInstructionId', p_instruction_id, 'capturedAmount', p_capture_amount,
      'balanceImpact', p_balance_impact, 'remainingExposure', v_remaining,
      'status', v_status), 'PENDING', p_correlation_id);
  return to_jsonb(v_application) || jsonb_build_object('reservationStatus', v_status,
    'remainingExposure', v_remaining, 'capturedAmount', v_reservation.captured_amount + p_capture_amount);
end;
$$;

create or replace function credit_wallet_service.prevent_canonical_reservation_insert_bypass()
returns trigger language plpgsql as $$
begin
  if new.scope_model = 'CANONICAL'
     and current_setting('credit_wallet_service.canonical_insert', true) <> 'approved' then
    raise exception 'Canonical reservations may only be created by Credit Wallet operations.';
  end if;
  return new;
end;
$$;
create trigger credit_reservations_canonical_insert_guard
before insert on public.credit_reservations
for each row execute function credit_wallet_service.prevent_canonical_reservation_insert_bypass();

comment on table public.credit_reservations is
  'Mutable reservation projection. Canonical rows are mutated only by Credit Wallet lifecycle functions; immutable evidence is stored separately.';
comment on column public.credit_reservations.settled_amount is
  'Compatibility mirror of captured_amount. New authoritative terminology is capture.';
comment on table credit_wallet_service.wallet_reservation_cancellations is
  'Append-only cancellation evidence. Automatic expiry is not required for the current credit-only launch.';

create trigger credit_settlement_applications_update_guard
before update on public.credit_settlement_applications
for each row execute function credit_wallet_service.prevent_evidence_mutation();

create or replace function public.cancel_credit_reservation(
  p_reservation_id uuid,
  p_correlation_id text default null,
  p_reason text default null
) returns public.credit_reservations language plpgsql as $$
declare v_reservation public.credit_reservations%rowtype;
begin
  select * into v_reservation from public.credit_reservations where id = p_reservation_id for update;
  if not found then raise exception 'Credit reservation not found.'; end if;
  if v_reservation.scope_model = 'CANONICAL' then
    raise exception 'Canonical reservation cancellation must use the Credit Wallet canonical operation boundary.';
  end if;
  if v_reservation.status in ('RELEASED', 'CAPTURED', 'CANCELLED') then return v_reservation; end if;
  update public.credit_reservations
    set released_amount = released_amount + remaining_exposure,
        remaining_exposure = 0,
        status = 'CANCELLED',
        cancelled_at = now(),
        completed_at = now(),
        metadata = metadata || jsonb_build_object(
          'cancelReason', p_reason, 'cancelCorrelationId', p_correlation_id)
  where id = p_reservation_id returning * into v_reservation;
  return v_reservation;
end;
$$;
