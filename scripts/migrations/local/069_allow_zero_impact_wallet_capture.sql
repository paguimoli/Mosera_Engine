create or replace function credit_wallet_service.validate_wallet_operation_request()
returns trigger
language plpgsql
as $$
declare
  v_scope credit_wallet_service.wallet_scopes%rowtype;
  v_instrument credit_wallet_service.wallet_instrument_definitions%rowtype;
begin
  select * into v_scope from credit_wallet_service.wallet_scopes where wallet_id = new.wallet_id;
  if not found then raise exception 'Canonical wallet scope is not registered.'; end if;
  if row(v_scope.tenant_id, v_scope.brand_id, v_scope.player_id, v_scope.instrument_code, v_scope.currency)
     is distinct from row(new.tenant_id, new.brand_id, new.player_id, new.instrument_code, new.currency) then
    raise exception 'Canonical wallet operation scope does not match wallet scope.';
  end if;
  select * into v_instrument from credit_wallet_service.wallet_instrument_definitions
   where instrument_code = new.instrument_code and lifecycle_state = 'ACTIVE';
  if not found then raise exception 'Wallet instrument is not active.'; end if;
  if new.operation_type in ('RESERVE', 'RELEASE', 'CANCEL') and not v_instrument.reservable then
    raise exception 'Wallet instrument does not support reservations.';
  end if;
  if new.operation_type = 'SETTLE' and not v_instrument.settlement_supported then
    raise exception 'Wallet instrument does not support settlement.';
  end if;
  if new.operation_type = 'EXPIRE' and not v_instrument.expires then
    raise exception 'Wallet instrument does not support expiry.';
  end if;
  if new.operation_type = 'RESERVE' and new.ticket_id is null then
    raise exception 'RESERVE requires ticket_id.';
  end if;
  if new.operation_type in ('RELEASE', 'CANCEL', 'SETTLE')
     and (new.ticket_id is null or new.reservation_id is null) then
    raise exception 'RELEASE, CANCEL, and SETTLE require ticket_id and reservation_id.';
  end if;
  if new.operation_type = 'SETTLE'
     and (new.settlement_id is null or new.settlement_batch_id is null
       or new.settlement_instruction_id is null or new.settlement_instruction_sequence is null
       or new.settlement_outcome is null or new.balance_impact_minor is null) then
    raise exception 'SETTLE requires authoritative settlement identity, outcome, and balance impact.';
  end if;
  if new.operation_type = 'REVERSE' and new.original_operation_id is null then
    raise exception 'REVERSE requires original_operation_id.';
  end if;
  return new;
end;
$$;
