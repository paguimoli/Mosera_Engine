alter table public.accounts
  add column if not exists funding_model text null,
  add column if not exists operating_mode text null,
  add column if not exists balance_authority text null,
  add column if not exists default_funding_source text null,
  add column if not exists weekly_accounting_mode text null,
  add column if not exists settlement_mode text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'accounts_funding_model_check'
  ) then
    alter table public.accounts
      add constraint accounts_funding_model_check
      check (funding_model is null or funding_model in ('CASH', 'CREDIT', 'HYBRID'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'accounts_operating_mode_check'
  ) then
    alter table public.accounts
      add constraint accounts_operating_mode_check
      check (
        operating_mode is null or operating_mode in ('CREDIT_EXPOSURE', 'COMMISSION')
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'accounts_balance_authority_check'
  ) then
    alter table public.accounts
      add constraint accounts_balance_authority_check
      check (balance_authority is null or balance_authority in ('INTERNAL', 'EXTERNAL'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'accounts_default_funding_source_check'
  ) then
    alter table public.accounts
      add constraint accounts_default_funding_source_check
      check (
        default_funding_source is null or
        default_funding_source in ('CASH', 'CREDIT', 'FREE_PLAY')
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'accounts_weekly_accounting_mode_check'
  ) then
    alter table public.accounts
      add constraint accounts_weekly_accounting_mode_check
      check (
        weekly_accounting_mode is null or
        weekly_accounting_mode in ('ZERO_BALANCE', 'CARRY_BALANCE')
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'accounts_settlement_mode_check'
  ) then
    alter table public.accounts
      add constraint accounts_settlement_mode_check
      check (
        settlement_mode is null or
        settlement_mode in ('AUTO_SETTLEMENT', 'MANUAL_SETTLEMENT')
      );
  end if;
end $$;
