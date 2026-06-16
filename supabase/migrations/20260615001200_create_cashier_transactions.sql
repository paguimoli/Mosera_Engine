create table if not exists public.cashier_transactions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  wallet_id uuid null references public.financial_wallets(id),
  transaction_type text not null,
  status text not null,
  amount numeric(18, 4) not null,
  currency_code text not null,
  payment_method text null,
  provider text null,
  provider_reference text null,
  requested_by_user_id uuid null references public.platform_users(id),
  approved_by_user_id uuid null references public.platform_users(id),
  rejected_by_user_id uuid null references public.platform_users(id),
  cancelled_by_user_id uuid null references public.platform_users(id),
  ledger_entry_id uuid null references public.financial_ledger_entries(id),
  reason text null,
  metadata jsonb not null default '{}'::jsonb,
  requested_at timestamptz not null default now(),
  approved_at timestamptz null,
  rejected_at timestamptz null,
  cancelled_at timestamptz null,
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cashier_transactions_transaction_type_check check (
    transaction_type in ('DEPOSIT', 'WITHDRAWAL')
  ),
  constraint cashier_transactions_status_check check (
    status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED')
  ),
  constraint cashier_transactions_amount_check check (amount > 0)
);

create index if not exists cashier_transactions_account_id_idx
  on public.cashier_transactions (account_id);

create index if not exists cashier_transactions_wallet_id_idx
  on public.cashier_transactions (wallet_id);

create index if not exists cashier_transactions_transaction_type_idx
  on public.cashier_transactions (transaction_type);

create index if not exists cashier_transactions_status_idx
  on public.cashier_transactions (status);

create index if not exists cashier_transactions_currency_code_idx
  on public.cashier_transactions (currency_code);

create index if not exists cashier_transactions_provider_idx
  on public.cashier_transactions (provider);

create index if not exists cashier_transactions_provider_reference_idx
  on public.cashier_transactions (provider_reference);

create index if not exists cashier_transactions_requested_at_idx
  on public.cashier_transactions (requested_at);

create index if not exists cashier_transactions_approved_at_idx
  on public.cashier_transactions (approved_at);

create index if not exists cashier_transactions_completed_at_idx
  on public.cashier_transactions (completed_at);

drop trigger if exists set_cashier_transactions_updated_at on public.cashier_transactions;
create trigger set_cashier_transactions_updated_at
  before update on public.cashier_transactions
  for each row
  execute function public.set_updated_at();

alter table public.cashier_transactions enable row level security;
