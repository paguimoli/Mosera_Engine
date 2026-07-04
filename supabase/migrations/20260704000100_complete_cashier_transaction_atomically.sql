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
