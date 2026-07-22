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
      new.metadata ->> 'originatingAuthority' = 'settlement-service'
      and new.metadata ->> 'instructionType' in (
        'LEDGER_REVERSAL',
        'SETTLEMENT_REVERSAL'
      )
    ) then
    raise exception 'Arbitrary ledger reversal posting is not allowed.';
  end if;

  return new;
end;
$$;
