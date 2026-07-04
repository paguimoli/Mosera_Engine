create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  account_type text not null,
  account_code text not null unique,
  display_name text not null,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (account_type in ('SUPER_MASTER', 'MASTER_AGENT', 'AGENT', 'PLAYER')),
  check (status in ('ACTIVE', 'DISABLED'))
);

drop trigger if exists set_accounts_updated_at on public.accounts;
create trigger set_accounts_updated_at
before update on public.accounts
for each row execute function public.set_updated_at();

create table if not exists public.financial_wallets (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  wallet_type text not null,
  currency_code text not null,
  balance_authority text not null,
  status text not null,
  balance numeric(18, 4) not null default 0,
  credit_limit numeric(18, 4),
  funding_model text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, wallet_type),
  check (wallet_type in ('CASH', 'CREDIT', 'FREE_PLAY')),
  check (balance_authority in ('INTERNAL', 'EXTERNAL')),
  check (status in ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  check (funding_model in ('CASH', 'CREDIT', 'HYBRID'))
);

create index if not exists financial_wallets_account_id_idx
  on public.financial_wallets (account_id);

drop trigger if exists set_financial_wallets_updated_at on public.financial_wallets;
create trigger set_financial_wallets_updated_at
before update on public.financial_wallets
for each row execute function public.set_updated_at();

create table if not exists public.financial_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.financial_wallets(id),
  account_id uuid not null references public.accounts(id),
  transaction_type text not null,
  direction text not null,
  amount numeric(18, 4) not null,
  balance_after numeric(18, 4) not null,
  currency_code text not null,
  reference_type text,
  reference_id text,
  idempotency_key text unique,
  reversal_of_ledger_entry_id uuid references public.financial_ledger_entries(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (direction in ('CREDIT', 'DEBIT')),
  check (amount > 0),
  check (
    transaction_type in (
      'DEPOSIT',
      'WITHDRAWAL',
      'TICKET_STAKE',
      'TICKET_WIN',
      'TICKET_REFUND',
      'TICKET_VOID',
      'FREE_PLAY_CREDIT',
      'FREE_PLAY_STAKE',
      'FREE_PLAY_WIN',
      'MANUAL_CREDIT_ADJUSTMENT',
      'MANUAL_DEBIT_ADJUSTMENT',
      'SETTLEMENT_CREDIT',
      'SETTLEMENT_DEBIT',
      'ZERO_BALANCE_CREDIT',
      'ZERO_BALANCE_DEBIT',
      'REVERSAL'
    )
  )
);

create index if not exists financial_ledger_entries_wallet_id_idx
  on public.financial_ledger_entries (wallet_id);

create index if not exists financial_ledger_entries_reference_idx
  on public.financial_ledger_entries (reference_type, reference_id);

create table if not exists public.cashier_transactions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  wallet_id uuid references public.financial_wallets(id),
  transaction_type text not null,
  status text not null,
  amount numeric(18, 4) not null,
  currency_code text not null,
  payment_method text,
  provider text,
  provider_reference text,
  requested_by_user_id uuid,
  approved_by_user_id uuid,
  rejected_by_user_id uuid,
  cancelled_by_user_id uuid,
  ledger_entry_id uuid references public.financial_ledger_entries(id),
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  rejected_at timestamptz,
  cancelled_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (transaction_type in ('DEPOSIT', 'WITHDRAWAL')),
  check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED')),
  check (amount > 0)
);

create index if not exists cashier_transactions_status_idx
  on public.cashier_transactions (status);

drop trigger if exists set_cashier_transactions_updated_at on public.cashier_transactions;
create trigger set_cashier_transactions_updated_at
before update on public.cashier_transactions
for each row execute function public.set_updated_at();

create table if not exists public.outbox_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  aggregate_type text not null,
  aggregate_id text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  published_at timestamptz,
  last_error text,
  correlation_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status in ('PENDING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER'))
);

create index if not exists outbox_events_aggregate_idx
  on public.outbox_events (aggregate_type, aggregate_id);

create index if not exists outbox_events_status_idx
  on public.outbox_events (status);

drop trigger if exists set_outbox_events_updated_at on public.outbox_events;
create trigger set_outbox_events_updated_at
before update on public.outbox_events
for each row execute function public.set_updated_at();

create or replace function public.post_financial_ledger_entry(
  p_wallet_id uuid,
  p_transaction_type text,
  p_direction text,
  p_amount numeric,
  p_reference_type text default null,
  p_reference_id text default null,
  p_idempotency_key text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_reversal_of_ledger_entry_id uuid default null
)
returns public.financial_ledger_entries
language plpgsql
as $$
declare
  v_wallet public.financial_wallets%rowtype;
  v_existing_entry public.financial_ledger_entries%rowtype;
  v_inserted_entry public.financial_ledger_entries%rowtype;
  v_balance_after numeric(18, 4);
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Ledger amount must be positive.';
  end if;

  if p_transaction_type not in (
    'DEPOSIT',
    'WITHDRAWAL',
    'TICKET_STAKE',
    'TICKET_WIN',
    'TICKET_REFUND',
    'TICKET_VOID',
    'FREE_PLAY_CREDIT',
    'FREE_PLAY_STAKE',
    'FREE_PLAY_WIN',
    'MANUAL_CREDIT_ADJUSTMENT',
    'MANUAL_DEBIT_ADJUSTMENT',
    'SETTLEMENT_CREDIT',
    'SETTLEMENT_DEBIT',
    'ZERO_BALANCE_CREDIT',
    'ZERO_BALANCE_DEBIT',
    'REVERSAL'
  ) then
    raise exception 'Ledger transaction type is invalid.';
  end if;

  if p_direction not in ('CREDIT', 'DEBIT') then
    raise exception 'Ledger direction is invalid.';
  end if;

  select *
  into v_wallet
  from public.financial_wallets
  where id = p_wallet_id
  for update;

  if not found then
    raise exception 'Wallet not found.';
  end if;

  if v_wallet.status <> 'ACTIVE' then
    raise exception 'Wallet is not active.';
  end if;

  if p_idempotency_key is not null then
    select *
    into v_existing_entry
    from public.financial_ledger_entries
    where idempotency_key = p_idempotency_key;

    if found then
      return v_existing_entry;
    end if;
  end if;

  if p_direction = 'CREDIT' then
    v_balance_after := v_wallet.balance + p_amount;
  else
    v_balance_after := v_wallet.balance - p_amount;
  end if;

  insert into public.financial_ledger_entries (
    wallet_id,
    account_id,
    transaction_type,
    direction,
    amount,
    balance_after,
    currency_code,
    reference_type,
    reference_id,
    idempotency_key,
    reversal_of_ledger_entry_id,
    metadata
  )
  values (
    v_wallet.id,
    v_wallet.account_id,
    p_transaction_type,
    p_direction,
    p_amount,
    v_balance_after,
    v_wallet.currency_code,
    p_reference_type,
    p_reference_id,
    p_idempotency_key,
    p_reversal_of_ledger_entry_id,
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning *
  into v_inserted_entry;

  update public.financial_wallets
  set balance = v_balance_after
  where id = v_wallet.id;

  return v_inserted_entry;
exception
  when unique_violation then
    if p_idempotency_key is not null then
      select *
      into v_existing_entry
      from public.financial_ledger_entries
      where idempotency_key = p_idempotency_key;

      if found then
        return v_existing_entry;
      end if;
    end if;

    raise;
end;
$$;

create or replace function public.complete_cashier_transaction_atomically(
  p_transaction_id uuid,
  p_actor_user_id uuid default null,
  p_metadata jsonb default '{}'::jsonb,
  p_correlation_id text default null,
  p_simulate_outbox_failure boolean default false
)
returns public.cashier_transactions
language plpgsql
as $$
declare
  v_transaction public.cashier_transactions%rowtype;
  v_wallet public.financial_wallets%rowtype;
  v_ledger_entry public.financial_ledger_entries%rowtype;
  v_ledger_transaction_type text;
  v_ledger_direction text;
  v_idempotency_key text;
  v_outbox_event_id uuid;
begin
  select *
  into v_transaction
  from public.cashier_transactions
  where id = p_transaction_id
  for update;

  if not found then
    raise exception 'Cashier transaction not found.';
  end if;

  v_outbox_event_id := (
    substr(md5('cashier.transaction.completed:' || v_transaction.id::text), 1, 8) || '-' ||
    substr(md5('cashier.transaction.completed:' || v_transaction.id::text), 9, 4) || '-' ||
    substr(md5('cashier.transaction.completed:' || v_transaction.id::text), 13, 4) || '-' ||
    substr(md5('cashier.transaction.completed:' || v_transaction.id::text), 17, 4) || '-' ||
    substr(md5('cashier.transaction.completed:' || v_transaction.id::text), 21, 12)
  )::uuid;

  if v_transaction.status = 'COMPLETED' then
    if v_transaction.ledger_entry_id is null then
      raise exception 'Completed cashier transaction is missing ledger entry.';
    end if;

    insert into public.outbox_events (
      id,
      event_type,
      aggregate_type,
      aggregate_id,
      payload,
      status,
      correlation_id
    )
    values (
      v_outbox_event_id,
      'cashier.transaction.completed',
      'cashier_transaction',
      v_transaction.id::text,
      jsonb_build_object(
        'transactionId', v_transaction.id,
        'accountId', v_transaction.account_id,
        'walletId', v_transaction.wallet_id,
        'transactionType', v_transaction.transaction_type,
        'amount', v_transaction.amount,
        'currency', v_transaction.currency_code,
        'ledgerEntryId', v_transaction.ledger_entry_id
      ),
      'PENDING',
      p_correlation_id
    )
    on conflict (id) do nothing;

    return v_transaction;
  end if;

  if v_transaction.status <> 'APPROVED' then
    raise exception 'Cashier transaction must be APPROVED.';
  end if;

  if v_transaction.wallet_id is null then
    raise exception 'Cashier transaction wallet is required.';
  end if;

  select *
  into v_wallet
  from public.financial_wallets
  where id = v_transaction.wallet_id
  for update;

  if not found then
    raise exception 'Cashier transaction wallet not found.';
  end if;

  if v_wallet.account_id <> v_transaction.account_id then
    raise exception 'Cashier transaction wallet account mismatch.';
  end if;

  if v_wallet.status <> 'ACTIVE' then
    raise exception 'Cashier transaction wallet must be active.';
  end if;

  if v_wallet.wallet_type <> 'CASH' then
    raise exception 'Cashier transaction wallet must be CASH.';
  end if;

  if v_wallet.balance_authority <> 'INTERNAL' then
    raise exception 'Cashier transaction wallet must use INTERNAL balance authority.';
  end if;

  if v_transaction.transaction_type = 'DEPOSIT' then
    v_ledger_transaction_type := 'DEPOSIT';
    v_ledger_direction := 'CREDIT';
  elsif v_transaction.transaction_type = 'WITHDRAWAL' then
    v_ledger_transaction_type := 'WITHDRAWAL';
    v_ledger_direction := 'DEBIT';

    if v_transaction.amount > v_wallet.balance then
      raise exception 'Withdrawal amount exceeds CASH wallet balance.';
    end if;
  else
    raise exception 'Invalid cashier transaction type.';
  end if;

  if p_simulate_outbox_failure then
    raise exception 'Simulated cashier completion outbox failure.';
  end if;

  v_idempotency_key := 'cashier:' || v_transaction.id::text || ':completion';

  v_ledger_entry := public.post_financial_ledger_entry(
    v_transaction.wallet_id,
    v_ledger_transaction_type,
    v_ledger_direction,
    v_transaction.amount,
    'cashier_transaction',
    v_transaction.id::text,
    v_idempotency_key,
    jsonb_build_object(
      'cashierTransactionId', v_transaction.id,
      'cashierTransactionType', v_transaction.transaction_type,
      'actorUserId', p_actor_user_id
    ) || coalesce(p_metadata, '{}'::jsonb),
    null
  );

  update public.cashier_transactions
  set
    status = 'COMPLETED',
    ledger_entry_id = v_ledger_entry.id,
    metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
    completed_at = coalesce(completed_at, now())
  where id = v_transaction.id
  returning *
  into v_transaction;

  insert into public.outbox_events (
    id,
    event_type,
    aggregate_type,
    aggregate_id,
    payload,
    status,
    correlation_id
  )
  values (
    v_outbox_event_id,
    'cashier.transaction.completed',
    'cashier_transaction',
    v_transaction.id::text,
    jsonb_build_object(
      'transactionId', v_transaction.id,
      'accountId', v_transaction.account_id,
      'walletId', v_transaction.wallet_id,
      'transactionType', v_transaction.transaction_type,
      'amount', v_transaction.amount,
      'currency', v_transaction.currency_code,
      'ledgerEntryId', v_transaction.ledger_entry_id
    ),
    'PENDING',
    p_correlation_id
  );

  return v_transaction;
end;
$$;
