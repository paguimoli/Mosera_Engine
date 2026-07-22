alter table public.financial_ledger_entries
  add column if not exists canonical_request_hash text;

alter table public.financial_ledger_entries
  drop constraint if exists financial_ledger_entries_canonical_request_hash_format;

alter table public.financial_ledger_entries
  add constraint financial_ledger_entries_canonical_request_hash_format
  check (canonical_request_hash is null or canonical_request_hash like 'sha256:%');

create index if not exists financial_ledger_entries_canonical_request_hash_idx
  on public.financial_ledger_entries (canonical_request_hash);

create or replace function public.post_financial_ledger_entry(
  p_wallet_id uuid,
  p_transaction_type text,
  p_direction text,
  p_amount numeric,
  p_reference_type text default null,
  p_reference_id text default null,
  p_idempotency_key text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_reversal_of_ledger_entry_id uuid default null,
  p_canonical_request_hash text default null
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

  if p_canonical_request_hash is not null
    and p_canonical_request_hash not like 'sha256:%' then
    raise exception 'Ledger canonical request hash must be sha256.';
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
      if p_canonical_request_hash is not null
        and v_existing_entry.canonical_request_hash is not null
        and v_existing_entry.canonical_request_hash <> p_canonical_request_hash then
        raise exception 'Ledger idempotency conflict.';
      end if;

      if p_canonical_request_hash is not null
        and v_existing_entry.canonical_request_hash is null then
        raise exception 'Ledger idempotency conflict.';
      end if;

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
    canonical_request_hash,
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
    p_canonical_request_hash,
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
        if p_canonical_request_hash is not null
          and (
            v_existing_entry.canonical_request_hash is null
            or v_existing_entry.canonical_request_hash <> p_canonical_request_hash
          ) then
          raise exception 'Ledger idempotency conflict.';
        end if;

        return v_existing_entry;
      end if;
    end if;

    raise;
end;
$$;
