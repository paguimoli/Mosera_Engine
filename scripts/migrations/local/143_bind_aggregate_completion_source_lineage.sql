begin;

create or replace function ticket_completion_authority.validate_completion_source_lineage()
returns trigger language plpgsql as $$
declare
  v_ticket_id uuid;
  v_item_ticket_id uuid;
  v_settlement settlement_service.authoritative_settlement_records%rowtype;
  v_ledger_attempt settlement_service.financial_instruction_execution_attempts%rowtype;
  v_wallet_attempt settlement_service.financial_instruction_execution_attempts%rowtype;
begin
  select ticket_id into v_ticket_id
  from ticket_completion_authority.completion_requests where request_id = new.request_id;
  select ticket_id into v_item_ticket_id
  from ticket_authority.ticket_items where ticket_item_id = new.ticket_item_id;
  select * into v_settlement
  from settlement_service.authoritative_settlement_records where settlement_id = new.settlement_id;
  select * into v_ledger_attempt
  from settlement_service.financial_instruction_execution_attempts
  where attempt_id = new.ledger_execution_attempt_id;
  select * into v_wallet_attempt
  from settlement_service.financial_instruction_execution_attempts
  where attempt_id = new.wallet_execution_attempt_id;

  if v_ticket_id is null or v_item_ticket_id <> v_ticket_id
     or v_settlement.ticket_id <> v_ticket_id::text then
    raise exception 'Completion source ticket, item, and Settlement lineage do not match.';
  end if;

  if v_settlement.ticket_line_id <> new.ticket_item_id::text
     and not exists (
       select 1
       from game_engine.ticket_draw_settlement_aggregates aggregate
       join game_engine.ticket_draw_settlement_aggregate_items aggregate_item
         on aggregate_item.settlement_input_id = aggregate.settlement_input_id
       where aggregate.settlement_input_id = v_settlement.settlement_input_id
         and aggregate.ticket_id = v_ticket_id
         and aggregate_item.ticket_item_id = new.ticket_item_id
         and v_settlement.ticket_line_id = 'aggregate:' || replace(aggregate.draw_id::text, '-', '')
     ) then
    raise exception 'Completion source ticket, item, and Settlement lineage do not match.';
  end if;

  if v_ledger_attempt.settlement_id <> new.settlement_id
     or v_ledger_attempt.target_service <> 'ledger-service'
     or v_wallet_attempt.settlement_id <> new.settlement_id
     or v_wallet_attempt.target_service <> 'credit-wallet-service' then
    raise exception 'Completion source financial execution lineage does not match Settlement.';
  end if;
  return new;
end;
$$;

comment on function ticket_completion_authority.validate_completion_source_lineage() is
  'Validates exact ticket-item financial completion lineage for item Settlement records and immutable ticket/draw aggregate attribution.';

commit;
