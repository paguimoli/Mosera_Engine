alter table public.financial_ledger_entries
  add column if not exists original_ledger_entry_hash text,
  add column if not exists reversal_reason_code text,
  add column if not exists reversal_policy_version text,
  add column if not exists canonical_reversal_hash text,
  add column if not exists reversal_governance_version text;

alter table public.financial_ledger_entries
  drop constraint if exists financial_ledger_entries_original_hash_format,
  drop constraint if exists financial_ledger_entries_reversal_hash_format,
  drop constraint if exists financial_ledger_entries_reversal_evidence_complete,
  drop constraint if exists financial_ledger_entries_reversal_reason_supported,
  drop constraint if exists financial_ledger_entries_reversal_not_self;

alter table public.financial_ledger_entries
  add constraint financial_ledger_entries_original_hash_format
    check (original_ledger_entry_hash is null or original_ledger_entry_hash like 'sha256:%'),
  add constraint financial_ledger_entries_reversal_hash_format
    check (canonical_reversal_hash is null or canonical_reversal_hash like 'sha256:%'),
  add constraint financial_ledger_entries_reversal_evidence_complete
    check (
      (
        reversal_of_ledger_entry_id is null
        and original_ledger_entry_hash is null
        and reversal_reason_code is null
        and reversal_policy_version is null
        and canonical_reversal_hash is null
        and reversal_governance_version is null
      )
      or
      (
        reversal_of_ledger_entry_id is not null
        and reversal_governance_version is null
      )
      or
      (
        reversal_of_ledger_entry_id is not null
        and transaction_type = 'REVERSAL'
        and original_ledger_entry_hash is not null
        and reversal_reason_code is not null
        and reversal_policy_version is not null
        and canonical_reversal_hash is not null
        and canonical_request_hash = canonical_reversal_hash
        and reversal_governance_version = 'ledger-reversal-v1'
      )
    ),
  add constraint financial_ledger_entries_reversal_reason_supported
    check (
      reversal_reason_code is null
      or reversal_reason_code in (
        'CORRECTION',
        'DUPLICATE_POSTING',
        'OPERATOR_CORRECTION',
        'SETTLEMENT_REVERSAL',
        'VOID'
      )
    ),
  add constraint financial_ledger_entries_reversal_not_self
    check (reversal_of_ledger_entry_id is null or reversal_of_ledger_entry_id <> id);

create unique index if not exists financial_ledger_entries_one_reversal_per_original
  on public.financial_ledger_entries (reversal_of_ledger_entry_id)
  where reversal_of_ledger_entry_id is not null;

create index if not exists financial_ledger_entries_original_hash_idx
  on public.financial_ledger_entries (original_ledger_entry_hash)
  where original_ledger_entry_hash is not null;

create index if not exists financial_ledger_entries_canonical_reversal_hash_idx
  on public.financial_ledger_entries (canonical_reversal_hash)
  where canonical_reversal_hash is not null;

create or replace function public.prevent_financial_ledger_entry_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Financial ledger entries are immutable; corrections require a new reversal entry.';
end;
$$;

create or replace function public.validate_financial_ledger_entry_insert()
returns trigger
language plpgsql
as $$
begin
  if new.reversal_of_ledger_entry_id is not null
    and (
      new.reversal_governance_version <> 'ledger-reversal-v1'
      or new.original_ledger_entry_hash is null
      or new.reversal_reason_code is null
      or new.reversal_policy_version is null
      or new.canonical_reversal_hash is null
    ) then
    raise exception 'Ledger reversal evidence is incomplete.';
  end if;

  if new.transaction_type = 'REVERSAL'
    and new.reversal_of_ledger_entry_id is null
    and not (
      new.metadata ->> 'instructionType' = 'LEDGER_REVERSAL'
      and new.metadata ->> 'originatingAuthority' = 'settlement-service'
    ) then
    raise exception 'Arbitrary ledger reversal posting is not allowed.';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_financial_ledger_entries_insert on public.financial_ledger_entries;
create trigger validate_financial_ledger_entries_insert
before insert on public.financial_ledger_entries
for each row execute function public.validate_financial_ledger_entry_insert();

drop trigger if exists prevent_financial_ledger_entries_update on public.financial_ledger_entries;
create trigger prevent_financial_ledger_entries_update
before update on public.financial_ledger_entries
for each row execute function public.prevent_financial_ledger_entry_mutation();

drop trigger if exists prevent_financial_ledger_entries_delete on public.financial_ledger_entries;
create trigger prevent_financial_ledger_entries_delete
before delete on public.financial_ledger_entries
for each row execute function public.prevent_financial_ledger_entry_mutation();

drop function if exists public.post_financial_ledger_entry(
  uuid,
  text,
  text,
  numeric,
  text,
  text,
  text,
  jsonb,
  uuid,
  text
);

create function public.post_financial_ledger_entry(
  p_wallet_id uuid,
  p_transaction_type text,
  p_direction text,
  p_amount numeric,
  p_reference_type text default null,
  p_reference_id text default null,
  p_idempotency_key text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_reversal_of_ledger_entry_id uuid default null,
  p_canonical_request_hash text default null,
  p_original_ledger_entry_hash text default null,
  p_reversal_reason_code text default null,
  p_reversal_policy_version text default null,
  p_canonical_reversal_hash text default null
)
returns public.financial_ledger_entries
language plpgsql
as $$
declare
  v_wallet public.financial_wallets%rowtype;
  v_original_entry public.financial_ledger_entries%rowtype;
  v_existing_entry public.financial_ledger_entries%rowtype;
  v_inserted_entry public.financial_ledger_entries%rowtype;
  v_existing_reversal public.financial_ledger_entries%rowtype;
  v_balance_after numeric(18, 4);
  v_expected_direction text;
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
        and (
          v_existing_entry.canonical_request_hash is null
          or v_existing_entry.canonical_request_hash <> p_canonical_request_hash
        ) then
        raise exception 'Ledger idempotency conflict.';
      end if;

      return v_existing_entry;
    end if;
  end if;

  if p_reversal_of_ledger_entry_id is not null then
    if p_transaction_type <> 'REVERSAL' then
      raise exception 'Ledger reversal transaction type is required.';
    end if;

    if p_original_ledger_entry_hash is null
      or p_reversal_reason_code is null
      or p_reversal_policy_version is null
      or p_canonical_reversal_hash is null then
      raise exception 'Ledger reversal evidence is incomplete.';
    end if;

    if p_canonical_request_hash is distinct from p_canonical_reversal_hash then
      raise exception 'Ledger canonical reversal hash mismatch.';
    end if;

    select *
    into v_original_entry
    from public.financial_ledger_entries
    where id = p_reversal_of_ledger_entry_id;

    if not found then
      raise exception 'Original ledger entry not found.';
    end if;

    if v_original_entry.reversal_of_ledger_entry_id is not null
      or v_original_entry.transaction_type = 'REVERSAL' then
      raise exception 'Ledger reversal conflict.';
    end if;

    if v_original_entry.canonical_request_hash is null
      or v_original_entry.canonical_request_hash <> p_original_ledger_entry_hash then
      raise exception 'Original ledger entry hash mismatch.';
    end if;

    v_expected_direction := case
      when v_original_entry.direction = 'CREDIT' then 'DEBIT'
      else 'CREDIT'
    end;

    if v_original_entry.wallet_id <> p_wallet_id
      or v_original_entry.account_id <> v_wallet.account_id
      or v_original_entry.currency_code <> v_wallet.currency_code
      or v_original_entry.amount <> p_amount
      or v_expected_direction <> p_direction then
      raise exception 'Ledger reversal financial dimensions mismatch.';
    end if;

    select *
    into v_existing_reversal
    from public.financial_ledger_entries
    where reversal_of_ledger_entry_id = p_reversal_of_ledger_entry_id;

    if found then
      raise exception 'Ledger reversal conflict.';
    end if;
  elsif p_original_ledger_entry_hash is not null
    or p_reversal_reason_code is not null
    or p_reversal_policy_version is not null
    or p_canonical_reversal_hash is not null then
    raise exception 'Ledger reversal evidence requires an original ledger entry.';
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
    original_ledger_entry_hash,
    reversal_reason_code,
    reversal_policy_version,
    canonical_reversal_hash,
    reversal_governance_version,
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
    p_original_ledger_entry_hash,
    p_reversal_reason_code,
    p_reversal_policy_version,
    p_canonical_reversal_hash,
    case
      when p_reversal_of_ledger_entry_id is not null then 'ledger-reversal-v1'
      else null
    end,
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

    if p_reversal_of_ledger_entry_id is not null then
      raise exception 'Ledger reversal conflict.';
    end if;

    raise;
end;
$$;
