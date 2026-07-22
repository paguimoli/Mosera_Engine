create table if not exists ledger_service.ledger_transactions (
  id uuid primary key,
  transaction_hash text not null unique,
  originating_authority text not null,
  instruction_id text not null,
  instruction_hash text not null,
  posting_request_id uuid not null unique
    references ledger_service.ledger_posting_requests(id),
  source_ledger_entry_id uuid not null unique
    references public.financial_ledger_entries(id),
  transaction_type text not null,
  currency text not null,
  effective_at timestamptz not null,
  idempotency_key text not null unique,
  canonical_transaction_hash text not null unique,
  reverses_transaction_id uuid references ledger_service.ledger_transactions(id),
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ledger_transactions_transaction_hash_format
    check (transaction_hash ~ '^sha256:[0-9a-f]{64}$'),
  constraint ledger_transactions_instruction_hash_format
    check (instruction_hash ~ '^sha256:[0-9a-f]{64}$'),
  constraint ledger_transactions_canonical_hash_format
    check (canonical_transaction_hash ~ '^sha256:[0-9a-f]{64}$'),
  constraint ledger_transactions_currency_format
    check (currency ~ '^[A-Z]{3}$'),
  constraint ledger_transactions_not_self_reversing
    check (reverses_transaction_id is null or reverses_transaction_id <> id)
);

create table if not exists ledger_service.ledger_entries (
  id uuid primary key,
  transaction_id uuid not null references ledger_service.ledger_transactions(id),
  account_id uuid not null,
  wallet_id uuid,
  account_class text not null,
  debit_amount bigint not null default 0,
  credit_amount bigint not null default 0,
  currency text not null,
  direction text not null,
  posting_sequence smallint not null,
  reversal_of_entry_id uuid references ledger_service.ledger_entries(id),
  canonical_entry_hash text not null unique,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ledger_entries_transaction_sequence_unique
    unique (transaction_id, posting_sequence),
  constraint ledger_entries_account_class_supported
    check (account_class in ('PLAYER_LIABILITY', 'SETTLEMENT_CLEARING', 'OPERATOR_CLEARING')),
  constraint ledger_entries_one_sided_amount
    check (
      (debit_amount > 0 and credit_amount = 0 and direction = 'DEBIT')
      or (credit_amount > 0 and debit_amount = 0 and direction = 'CREDIT')
    ),
  constraint ledger_entries_currency_format
    check (currency ~ '^[A-Z]{3}$'),
  constraint ledger_entries_posting_sequence_positive
    check (posting_sequence > 0),
  constraint ledger_entries_hash_format
    check (canonical_entry_hash ~ '^sha256:[0-9a-f]{64}$'),
  constraint ledger_entries_not_self_reversing
    check (reversal_of_entry_id is null or reversal_of_entry_id <> id)
);

create index if not exists idx_ledger_transactions_transaction_hash
  on ledger_service.ledger_transactions (transaction_hash);
create index if not exists idx_ledger_transactions_instruction
  on ledger_service.ledger_transactions (instruction_id, instruction_hash);
create index if not exists idx_ledger_transactions_posting_request
  on ledger_service.ledger_transactions (posting_request_id);
create index if not exists idx_ledger_transactions_reversal
  on ledger_service.ledger_transactions (reverses_transaction_id)
  where reverses_transaction_id is not null;
create index if not exists idx_ledger_entries_transaction
  on ledger_service.ledger_entries (transaction_id, posting_sequence);
create index if not exists idx_ledger_entries_reversal
  on ledger_service.ledger_entries (reversal_of_entry_id)
  where reversal_of_entry_id is not null;
create index if not exists idx_ledger_entries_account
  on ledger_service.ledger_entries (account_id, created_at);

create or replace function ledger_service.assert_balanced_ledger_transaction(p_transaction_id uuid)
returns void
language plpgsql
as $$
declare
  v_currency text;
  v_line_count integer;
  v_currency_count integer;
  v_debits numeric;
  v_credits numeric;
begin
  select currency into v_currency
  from ledger_service.ledger_transactions
  where id = p_transaction_id;

  select count(*), count(distinct currency), coalesce(sum(debit_amount), 0), coalesce(sum(credit_amount), 0)
  into v_line_count, v_currency_count, v_debits, v_credits
  from ledger_service.ledger_entries
  where transaction_id = p_transaction_id;

  if v_line_count < 2 then
    raise exception 'Ledger transaction must contain at least two entries.';
  end if;

  if v_currency_count <> 1 or exists (
    select 1 from ledger_service.ledger_entries
    where transaction_id = p_transaction_id and currency <> v_currency
  ) then
    raise exception 'Ledger transaction entries must use the transaction currency.';
  end if;

  if v_debits <> v_credits then
    raise exception 'Ledger transaction is not balanced.';
  end if;

  return;
end;
$$;

create or replace function ledger_service.assert_balanced_ledger_transaction_header()
returns trigger
language plpgsql
as $$
begin
  perform ledger_service.assert_balanced_ledger_transaction(new.id);
  return new;
end;
$$;

create or replace function ledger_service.assert_balanced_ledger_transaction_entry()
returns trigger
language plpgsql
as $$
begin
  perform ledger_service.assert_balanced_ledger_transaction(new.transaction_id);
  return new;
end;
$$;

drop trigger if exists ledger_transactions_balance_guard on ledger_service.ledger_transactions;
create constraint trigger ledger_transactions_balance_guard
after insert on ledger_service.ledger_transactions
deferrable initially deferred
for each row execute function ledger_service.assert_balanced_ledger_transaction_header();

drop trigger if exists ledger_entries_balance_guard on ledger_service.ledger_entries;
create constraint trigger ledger_entries_balance_guard
after insert on ledger_service.ledger_entries
deferrable initially deferred
for each row execute function ledger_service.assert_balanced_ledger_transaction_entry();

drop trigger if exists ledger_transactions_update_guard on ledger_service.ledger_transactions;
create trigger ledger_transactions_update_guard
before update on ledger_service.ledger_transactions
for each row execute function ledger_service.prevent_ledger_evidence_update();

drop trigger if exists ledger_transactions_delete_guard on ledger_service.ledger_transactions;
create trigger ledger_transactions_delete_guard
before delete on ledger_service.ledger_transactions
for each row execute function ledger_service.prevent_ledger_evidence_delete();

drop trigger if exists ledger_entries_update_guard on ledger_service.ledger_entries;
create trigger ledger_entries_update_guard
before update on ledger_service.ledger_entries
for each row execute function ledger_service.prevent_ledger_evidence_update();

drop trigger if exists ledger_entries_delete_guard on ledger_service.ledger_entries;
create trigger ledger_entries_delete_guard
before delete on ledger_service.ledger_entries
for each row execute function ledger_service.prevent_ledger_evidence_delete();

alter table ledger_service.ledger_posting_requests
  add column if not exists journal_transaction_id uuid
    references ledger_service.ledger_transactions(id);

create unique index if not exists ux_ledger_posting_requests_journal_transaction
  on ledger_service.ledger_posting_requests (journal_transaction_id)
  where journal_transaction_id is not null;

create or replace function ledger_service.validate_ledger_posting_request_update()
returns trigger
language plpgsql
as $$
begin
  if current_setting('ledger_service.allow_request_status_update', true) <> 'true' then
    raise exception 'Ledger posting requests may only change through governed status persistence.';
  end if;

  if row(
    new.id, new.request_kind, new.instruction_id, new.instruction_type,
    new.instruction_hash, new.originating_authority, new.settlement_record_id,
    new.ledger_wallet_id, new.ledger_account_id, new.direction, new.amount_minor,
    new.currency, new.minor_unit_precision, new.transaction_type,
    new.idempotency_key, new.canonical_request_hash, new.effective_at,
    new.original_ledger_entry_id, new.original_ledger_entry_hash,
    new.correlation_metadata, new.created_at
  ) is distinct from row(
    old.id, old.request_kind, old.instruction_id, old.instruction_type,
    old.instruction_hash, old.originating_authority, old.settlement_record_id,
    old.ledger_wallet_id, old.ledger_account_id, old.direction, old.amount_minor,
    old.currency, old.minor_unit_precision, old.transaction_type,
    old.idempotency_key, old.canonical_request_hash, old.effective_at,
    old.original_ledger_entry_id, old.original_ledger_entry_hash,
    old.correlation_metadata, old.created_at
  ) then
    raise exception 'Ledger posting request financial evidence is immutable.';
  end if;

  if old.request_status = 'COMPLETED' and new.request_status <> 'COMPLETED' then
    raise exception 'Completed Ledger posting requests are terminal.';
  end if;

  if old.journal_transaction_id is not null
    and new.journal_transaction_id is distinct from old.journal_transaction_id then
    raise exception 'Ledger posting request journal reference is immutable once assigned.';
  end if;

  if new.request_status = 'COMPLETED'
    and (new.ledger_entry_id is null or new.journal_transaction_id is null) then
    raise exception 'Completed Ledger posting requests require entry and balanced journal references.';
  end if;

  if new.journal_transaction_id is not null and not exists (
    select 1
    from ledger_service.ledger_transactions tx
    where tx.id = new.journal_transaction_id
      and tx.posting_request_id = new.id
      and tx.source_ledger_entry_id = new.ledger_entry_id
  ) then
    raise exception 'Ledger posting request journal reference is inconsistent.';
  end if;

  return new;
end;
$$;
