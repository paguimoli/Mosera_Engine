create or replace function public.reserve_credit_exposure(
  p_player_id uuid,
  p_ticket_id text,
  p_amount bigint,
  p_currency text,
  p_idempotency_key text,
  p_correlation_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.credit_reservations
language plpgsql
as $$
declare
  v_existing public.credit_reservations%rowtype;
  v_wallet public.financial_wallets%rowtype;
  v_pending_exposure bigint;
  v_credit_limit bigint;
  v_balance bigint;
  v_available_credit bigint;
  v_reservation public.credit_reservations%rowtype;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Credit reservation amount must be positive.';
  end if;

  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'Credit reservation currency is invalid.';
  end if;

  if p_ticket_id is null or btrim(p_ticket_id) = '' then
    raise exception 'Credit reservation ticket id is required.';
  end if;

  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'Credit reservation idempotency key is required.';
  end if;

  select *
    into v_existing
  from public.credit_reservations
  where idempotency_key = btrim(p_idempotency_key);

  if found then
    return v_existing;
  end if;

  select *
    into v_wallet
  from public.financial_wallets
  where account_id = p_player_id
    and wallet_type = 'CREDIT'
  for update;

  if not found then
    raise exception 'Credit wallet not found.';
  end if;

  if v_wallet.status <> 'ACTIVE' then
    raise exception 'Credit wallet is not active.';
  end if;

  if v_wallet.currency_code <> p_currency then
    raise exception 'Credit reservation currency does not match wallet currency.';
  end if;

  select coalesce(sum(remaining_exposure), 0)::bigint
    into v_pending_exposure
  from public.credit_reservations
  where player_id = p_player_id
    and status in ('RESERVED', 'PARTIALLY_RELEASED');

  v_credit_limit := coalesce(v_wallet.credit_limit, 0)::bigint;
  v_balance := coalesce(v_wallet.balance, 0)::bigint;
  v_available_credit := v_credit_limit + v_balance - v_pending_exposure;

  if v_available_credit < p_amount then
    raise exception 'Insufficient available credit.';
  end if;

  insert into public.credit_reservations (
    player_id,
    ticket_id,
    amount,
    currency,
    status,
    reserved_amount,
    released_amount,
    settled_amount,
    remaining_exposure,
    idempotency_key,
    correlation_id,
    metadata
  )
  values (
    p_player_id,
    btrim(p_ticket_id),
    p_amount,
    p_currency,
    'RESERVED',
    p_amount,
    0,
    0,
    p_amount,
    btrim(p_idempotency_key),
    p_correlation_id,
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning *
    into v_reservation;

  insert into public.outbox_events (
    event_type,
    aggregate_type,
    aggregate_id,
    payload,
    status,
    correlation_id
  )
  values (
    'credit.exposure.reserved',
    'credit_reservation',
    v_reservation.id::text,
    jsonb_build_object(
      'reservationId', v_reservation.id,
      'playerId', v_reservation.player_id,
      'ticketId', v_reservation.ticket_id,
      'reservedAmount', v_reservation.reserved_amount,
      'currency', v_reservation.currency
    ),
    'PENDING',
    p_correlation_id
  );

  return v_reservation;
end;
$$;

create or replace function public.release_credit_exposure(
  p_reservation_id uuid,
  p_ticket_id text,
  p_release_amount bigint,
  p_idempotency_key text,
  p_correlation_id text default null,
  p_reason text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns public.credit_reservations
language plpgsql
as $$
declare
  v_existing_release public.credit_reservation_releases%rowtype;
  v_reservation public.credit_reservations%rowtype;
  v_next_remaining bigint;
  v_next_status text;
begin
  if p_release_amount is null or p_release_amount <= 0 then
    raise exception 'Credit release amount must be positive.';
  end if;

  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'Credit release idempotency key is required.';
  end if;

  select *
    into v_existing_release
  from public.credit_reservation_releases
  where idempotency_key = btrim(p_idempotency_key);

  if found then
    select *
      into v_reservation
    from public.credit_reservations
    where id = v_existing_release.reservation_id;

    return v_reservation;
  end if;

  select *
    into v_reservation
  from public.credit_reservations
  where id = p_reservation_id
  for update;

  if not found then
    raise exception 'Credit reservation not found.';
  end if;

  if v_reservation.status not in ('RESERVED', 'PARTIALLY_RELEASED') then
    raise exception 'Credit reservation cannot be released.';
  end if;

  if p_ticket_id is not null and btrim(p_ticket_id) <> v_reservation.ticket_id then
    raise exception 'Credit release ticket id does not match reservation.';
  end if;

  if p_release_amount > v_reservation.remaining_exposure then
    raise exception 'Credit release exceeds remaining exposure.';
  end if;

  insert into public.credit_reservation_releases (
    reservation_id,
    ticket_id,
    release_amount,
    idempotency_key,
    correlation_id,
    reason,
    metadata
  )
  values (
    v_reservation.id,
    v_reservation.ticket_id,
    p_release_amount,
    btrim(p_idempotency_key),
    p_correlation_id,
    p_reason,
    coalesce(p_metadata, '{}'::jsonb)
  );

  v_next_remaining := v_reservation.remaining_exposure - p_release_amount;
  v_next_status := case
    when v_next_remaining = 0 then 'RELEASED'
    else 'PARTIALLY_RELEASED'
  end;

  update public.credit_reservations
    set released_amount = released_amount + p_release_amount,
        remaining_exposure = v_next_remaining,
        status = v_next_status,
        released_at = case
          when v_next_remaining = 0 then now()
          else released_at
        end
  where id = v_reservation.id
  returning *
    into v_reservation;

  insert into public.outbox_events (
    event_type,
    aggregate_type,
    aggregate_id,
    payload,
    status,
    correlation_id
  )
  values (
    'credit.exposure.released',
    'credit_reservation',
    v_reservation.id::text,
    jsonb_build_object(
      'reservationId', v_reservation.id,
      'playerId', v_reservation.player_id,
      'ticketId', v_reservation.ticket_id,
      'releasedAmount', p_release_amount,
      'currency', v_reservation.currency,
      'remainingExposure', v_reservation.remaining_exposure,
      'status', v_reservation.status
    ),
    'PENDING',
    p_correlation_id
  );

  return v_reservation;
end;
$$;
