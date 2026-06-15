create table if not exists public.financial_wallets (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  wallet_type text not null,
  currency_code text not null,
  balance_authority text not null,
  status text not null,
  balance numeric(18, 4) not null default 0,
  credit_limit numeric(18, 4) null,
  funding_model text not null,
  operating_mode text null,
  default_funding_source text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_wallets_wallet_type_check check (
    wallet_type in ('CASH', 'CREDIT', 'FREE_PLAY')
  ),
  constraint financial_wallets_balance_authority_check check (
    balance_authority in ('INTERNAL', 'EXTERNAL')
  ),
  constraint financial_wallets_status_check check (
    status in ('ACTIVE', 'SUSPENDED', 'CLOSED')
  ),
  constraint financial_wallets_funding_model_check check (
    funding_model in ('CASH', 'CREDIT', 'HYBRID')
  ),
  constraint financial_wallets_operating_mode_check check (
    operating_mode is null or operating_mode in ('CREDIT_EXPOSURE', 'COMMISSION')
  ),
  constraint financial_wallets_default_funding_source_check check (
    default_funding_source is null or
    default_funding_source in ('CASH', 'CREDIT', 'FREE_PLAY')
  ),
  constraint financial_wallets_account_type_unique unique (account_id, wallet_type)
);

create index if not exists financial_wallets_account_id_idx
  on public.financial_wallets (account_id);

create index if not exists financial_wallets_wallet_type_idx
  on public.financial_wallets (wallet_type);

create index if not exists financial_wallets_status_idx
  on public.financial_wallets (status);

create index if not exists financial_wallets_balance_authority_idx
  on public.financial_wallets (balance_authority);

create index if not exists financial_wallets_funding_model_idx
  on public.financial_wallets (funding_model);

create index if not exists financial_wallets_operating_mode_idx
  on public.financial_wallets (operating_mode);

drop trigger if exists set_financial_wallets_updated_at on public.financial_wallets;

create trigger set_financial_wallets_updated_at
  before update on public.financial_wallets
  for each row
  execute function public.set_updated_at();

alter table public.financial_wallets enable row level security;

create table if not exists public.financial_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.financial_wallets(id),
  account_id uuid not null references public.accounts(id),
  transaction_type text not null,
  direction text not null,
  amount numeric(18, 4) not null,
  balance_after numeric(18, 4) not null,
  currency_code text not null,
  reference_type text null,
  reference_id text null,
  idempotency_key text null unique,
  reversal_of_ledger_entry_id uuid null references public.financial_ledger_entries(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint financial_ledger_entries_direction_check check (
    direction in ('CREDIT', 'DEBIT')
  ),
  constraint financial_ledger_entries_amount_positive_check check (amount > 0),
  constraint financial_ledger_entries_transaction_type_check check (
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

create index if not exists financial_ledger_entries_account_id_idx
  on public.financial_ledger_entries (account_id);

create index if not exists financial_ledger_entries_transaction_type_idx
  on public.financial_ledger_entries (transaction_type);

create index if not exists financial_ledger_entries_reference_idx
  on public.financial_ledger_entries (reference_type, reference_id);

create index if not exists financial_ledger_entries_created_at_idx
  on public.financial_ledger_entries (created_at);

create index if not exists financial_ledger_entries_reversal_of_idx
  on public.financial_ledger_entries (reversal_of_ledger_entry_id);

alter table public.financial_ledger_entries enable row level security;
