create or replace function public.apply_credit_settlement(
  p_player_id uuid,
  p_reservation_id uuid,
  p_ticket_id text,
  p_settlement_id text,
  p_settlement_batch_id text,
  p_release_amount bigint,
  p_balance_impact bigint,
  p_currency text,
  p_outcome text,
  p_idempotency_key text,
  p_correlation_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  reservation_id uuid,
  player_id uuid,
  ticket_id text,
  settlement_id text,
  release_amount bigint,
  balance_impact bigint,
  balance_before bigint,
  currency text,
  balance_after bigint,
  operation_type text,
  idempotency_key text,
  correlation_id text,
  created_at timestamptz
)
language plpgsql
as $$
declare
  v_existing public.credit_settlement_applications%rowtype;
  v_reservation public.credit_reservations%rowtype;
  v_wallet public.financial_wallets%rowtype;
  v_application public.credit_settlement_applications%rowtype;
  v_balance_before bigint;
  v_balance_after bigint;
  v_next_remaining bigint;
  v_next_status text;
  v_operation_type text;
begin
  if p_release_amount is null or p_release_amount <= 0 then
    raise exception 'Credit settlement release amount must be positive.';
  end if;

  if p_balance_impact is null or p_balance_impact = 0 then
    raise exception 'Credit settlement balance impact must be non-zero.';
  end if;

  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'Credit settlement currency is invalid.';
  end if;

  if p_ticket_id is null or btrim(p_ticket_id) = '' then
    raise exception 'Credit settlement ticket id is required.';
  end if;

  if p_settlement_id is null or btrim(p_settlement_id) = '' then
    raise exception 'Credit settlement id is required.';
  end if;

  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'Credit settlement idempotency key is required.';
  end if;

  select csa.*
    into v_existing
  from public.credit_settlement_applications csa
  where csa.idempotency_key = btrim(p_idempotency_key);

  if found then
    return query
    select v_existing.id,
           v_existing.reservation_id,
           v_existing.player_id,
           v_existing.ticket_id,
           v_existing.settlement_id,
           v_existing.release_amount,
           v_existing.balance_impact,
           v_existing.balance_before,
           v_existing.currency,
           v_existing.balance_after,
           v_existing.operation_type,
           v_existing.idempotency_key,
           v_existing.correlation_id,
           v_existing.created_at;
    return;
  end if;

  select cr.*
    into v_reservation
  from public.credit_reservations cr
  where cr.id = p_reservation_id
  for update;

  if not found then
    raise exception 'Credit reservation not found.';
  end if;

  if v_reservation.player_id <> p_player_id then
    raise exception 'Credit settlement reservation does not belong to player.';
  end if;

  if v_reservation.ticket_id <> btrim(p_ticket_id) then
    raise exception 'Credit settlement ticket id does not match reservation.';
  end if;

  if v_reservation.status not in ('RESERVED', 'PARTIALLY_RELEASED') then
    raise exception 'Credit settlement cannot be applied to this reservation state.';
  end if;

  if v_reservation.currency <> p_currency then
    raise exception 'Credit settlement currency does not match reservation.';
  end if;

  if p_release_amount > v_reservation.remaining_exposure then
    raise exception 'Credit settlement release exceeds remaining exposure.';
  end if;

  select fw.*
    into v_wallet
  from public.financial_wallets fw
  where fw.account_id = p_player_id
    and fw.wallet_type = 'CREDIT'
  for update;

  if not found then
    raise exception 'Credit wallet not found.';
  end if;

  if v_wallet.status <> 'ACTIVE' then
    raise exception 'Credit wallet is not active.';
  end if;

  if v_wallet.currency_code <> p_currency then
    raise exception 'Credit settlement currency does not match wallet currency.';
  end if;

  v_balance_before := coalesce(v_wallet.balance, 0)::bigint;
  v_balance_after := v_balance_before + p_balance_impact;
  v_next_remaining := v_reservation.remaining_exposure - p_release_amount;
  v_operation_type := case
    when v_next_remaining = 0 then 'FULL_SETTLEMENT'
    else 'PARTIAL_SETTLEMENT'
  end;
  v_next_status := case
    when v_next_remaining = 0 then 'SETTLED'
    else 'PARTIALLY_RELEASED'
  end;

  update public.financial_wallets fw
    set balance = v_balance_after
  where fw.id = v_wallet.id;

  insert into public.credit_settlement_applications (
    reservation_id,
    player_id,
    ticket_id,
    settlement_id,
    release_amount,
    balance_impact,
    balance_before,
    balance_after,
    currency,
    operation_type,
    idempotency_key,
    correlation_id,
    metadata
  )
  values (
    v_reservation.id,
    v_reservation.player_id,
    v_reservation.ticket_id,
    btrim(p_settlement_id),
    p_release_amount,
    p_balance_impact,
    v_balance_before,
    v_balance_after,
    p_currency,
    v_operation_type,
    btrim(p_idempotency_key),
    p_correlation_id,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'settlementBatchId', p_settlement_batch_id,
      'outcome', p_outcome
    )
  )
  returning *
    into v_application;

  update public.credit_reservations cr
    set settled_amount = cr.settled_amount + p_release_amount,
        remaining_exposure = v_next_remaining,
        status = v_next_status,
        settled_at = case
          when v_next_remaining = 0 then now()
          else cr.settled_at
        end
  where cr.id = v_reservation.id;

  insert into public.outbox_events (
    event_type,
    aggregate_type,
    aggregate_id,
    payload,
    status,
    correlation_id
  )
  values (
    'credit.settlement.applied',
    'credit_settlement_application',
    v_application.id::text,
    jsonb_build_object(
      'settlementApplicationId', v_application.id,
      'reservationId', v_application.reservation_id,
      'playerId', v_application.player_id,
      'ticketId', v_application.ticket_id,
      'settlementId', v_application.settlement_id,
      'releaseAmount', v_application.release_amount,
      'balanceImpact', v_application.balance_impact,
      'balanceBefore', v_application.balance_before,
      'balanceAfter', v_application.balance_after,
      'currency', v_application.currency,
      'operationType', v_application.operation_type
    ),
    'PENDING',
    p_correlation_id
  );

  return query
  select v_application.id,
         v_application.reservation_id,
         v_application.player_id,
         v_application.ticket_id,
         v_application.settlement_id,
         v_application.release_amount,
         v_application.balance_impact,
         v_application.balance_before,
         v_application.currency,
         v_application.balance_after,
         v_application.operation_type,
         v_application.idempotency_key,
         v_application.correlation_id,
         v_application.created_at;
end;
$$;

create or replace function public.apply_credit_settlement(
  p_reservation_id uuid,
  p_ticket_id text,
  p_settlement_id text,
  p_release_amount bigint,
  p_balance_impact bigint,
  p_currency text,
  p_idempotency_key text,
  p_correlation_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  reservation_id uuid,
  player_id uuid,
  ticket_id text,
  settlement_id text,
  release_amount bigint,
  balance_impact bigint,
  balance_before bigint,
  currency text,
  balance_after bigint,
  operation_type text,
  idempotency_key text,
  correlation_id text,
  created_at timestamptz
)
language plpgsql
as $$
declare
  v_player_id uuid;
begin
  select cr.player_id
    into v_player_id
  from public.credit_reservations cr
  where cr.id = p_reservation_id;

  if not found then
    raise exception 'Credit reservation not found.';
  end if;

  return query
  select *
  from public.apply_credit_settlement(
    v_player_id,
    p_reservation_id,
    p_ticket_id,
    p_settlement_id,
    null,
    p_release_amount,
    p_balance_impact,
    p_currency,
    null,
    p_idempotency_key,
    p_correlation_id,
    p_metadata
  );
end;
$$;
