create or replace function credit_wallet_service.derive_legacy_settlement_instruction()
returns trigger
language plpgsql
as $$
begin
  if new.source_authority is null then
    new.source_authority := 'LEGACY';
    new.settlement_instruction_id := coalesce(new.settlement_instruction_id, new.settlement_id);
    new.settlement_instruction_sequence := coalesce(new.settlement_instruction_sequence, 0);
    new.settlement_instruction_hash := coalesce(
      new.settlement_instruction_hash,
      'sha256:' || encode(digest(
        concat_ws('|', new.settlement_id, new.reservation_id::text,
          new.release_amount::text, new.balance_impact::text,
          new.currency, new.operation_type),
        'sha256'), 'hex'));
  end if;
  return new;
end;
$$;

drop trigger if exists credit_settlement_applications_legacy_instruction
  on public.credit_settlement_applications;
create trigger credit_settlement_applications_legacy_instruction
before insert on public.credit_settlement_applications
for each row execute function credit_wallet_service.derive_legacy_settlement_instruction();

comment on function credit_wallet_service.derive_legacy_settlement_instruction() is
  'Derives deterministic instruction identity only for the pre-canonical settlement RPC. Canonical callers provide source authority and instruction identity explicitly.';
