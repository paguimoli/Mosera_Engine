create table if not exists public.credit_reservations (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.accounts(id) on delete cascade,
  ticket_id text not null,
  amount bigint not null,
  currency text not null,
  status text not null,
  reserved_amount bigint not null,
  released_amount bigint not null default 0,
  settled_amount bigint not null default 0,
  remaining_exposure bigint not null,
  idempotency_key text not null unique,
  correlation_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  released_at timestamptz,
  settled_at timestamptz,
  cancelled_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  check (status in ('RESERVED', 'PARTIALLY_RELEASED', 'RELEASED', 'SETTLED', 'CANCELLED', 'FAILED')),
  check (amount > 0),
  check (reserved_amount > 0),
  check (released_amount >= 0),
  check (settled_amount >= 0),
  check (remaining_exposure >= 0),
  check (currency ~ '^[A-Z]{3}$')
);

create index if not exists credit_reservations_player_id_idx
  on public.credit_reservations (player_id);

create index if not exists credit_reservations_ticket_id_idx
  on public.credit_reservations (ticket_id);

create index if not exists credit_reservations_status_idx
  on public.credit_reservations (status);

create index if not exists credit_reservations_correlation_id_idx
  on public.credit_reservations (correlation_id);

create index if not exists credit_reservations_created_at_idx
  on public.credit_reservations (created_at);

drop trigger if exists set_credit_reservations_updated_at on public.credit_reservations;
create trigger set_credit_reservations_updated_at
before update on public.credit_reservations
for each row execute function public.set_updated_at();

create table if not exists public.credit_reservation_releases (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.credit_reservations(id) on delete cascade,
  ticket_id text not null,
  release_amount bigint not null,
  idempotency_key text not null unique,
  correlation_id text,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (release_amount > 0)
);

create index if not exists credit_reservation_releases_reservation_id_idx
  on public.credit_reservation_releases (reservation_id);

create index if not exists credit_reservation_releases_ticket_id_idx
  on public.credit_reservation_releases (ticket_id);

create index if not exists credit_reservation_releases_correlation_id_idx
  on public.credit_reservation_releases (correlation_id);

create index if not exists credit_reservation_releases_created_at_idx
  on public.credit_reservation_releases (created_at);

create table if not exists public.credit_settlement_applications (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.credit_reservations(id) on delete cascade,
  player_id uuid not null references public.accounts(id) on delete cascade,
  ticket_id text not null,
  settlement_id text not null,
  release_amount bigint not null,
  balance_impact bigint not null,
  balance_before bigint not null,
  balance_after bigint not null,
  currency text not null,
  operation_type text not null,
  idempotency_key text not null unique,
  correlation_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (release_amount > 0),
  check (currency ~ '^[A-Z]{3}$'),
  check (operation_type in ('PARTIAL_SETTLEMENT', 'FULL_SETTLEMENT'))
);

create index if not exists credit_settlement_applications_reservation_id_idx
  on public.credit_settlement_applications (reservation_id);

create index if not exists credit_settlement_applications_player_id_idx
  on public.credit_settlement_applications (player_id);

create index if not exists credit_settlement_applications_ticket_id_idx
  on public.credit_settlement_applications (ticket_id);

create index if not exists credit_settlement_applications_settlement_id_idx
  on public.credit_settlement_applications (settlement_id);

create index if not exists credit_settlement_applications_correlation_id_idx
  on public.credit_settlement_applications (correlation_id);

create index if not exists credit_settlement_applications_created_at_idx
  on public.credit_settlement_applications (created_at);

create or replace function public.get_player_credit_summary(
  p_player_id uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_wallet public.financial_wallets%rowtype;
  v_pending_exposure bigint;
  v_credit_limit bigint;
  v_balance bigint;
  v_available_credit bigint;
begin
  select *
    into v_wallet
  from public.financial_wallets
  where account_id = p_player_id
    and wallet_type = 'CREDIT';

  if not found then
    return null;
  end if;

  select coalesce(sum(remaining_exposure), 0)::bigint
    into v_pending_exposure
  from public.credit_reservations
  where player_id = p_player_id
    and status in ('RESERVED', 'PARTIALLY_RELEASED');

  v_credit_limit := coalesce(v_wallet.credit_limit, 0)::bigint;
  v_balance := coalesce(v_wallet.balance, 0)::bigint;
  v_available_credit := v_credit_limit + v_balance - v_pending_exposure;

  return jsonb_build_object(
    'playerId', p_player_id,
    'walletId', v_wallet.id,
    'creditLimit', v_credit_limit,
    'balance', v_balance,
    'pendingExposure', v_pending_exposure,
    'availableCredit', v_available_credit,
    'currency', v_wallet.currency_code
  );
end;
$$;
