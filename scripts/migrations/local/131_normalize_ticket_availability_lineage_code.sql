begin;

do $$
declare
  v_identity regprocedure := 'ticket_authority.bind_and_validate_ticket_lineage()'::regprocedure;
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(v_identity) into v_definition;

  v_updated := replace(
    v_definition,
    E'            v_availability.market_id, v_availability.game_code,',
    E'            v_availability.market_id, lower(v_availability.game_code),'
  );
  if v_updated = v_definition then
    raise exception 'Availability-side ticket lineage code normalization could not be installed.';
  end if;
  v_definition := v_updated;

  v_updated := replace(
    v_definition,
    E'        row(new.tenant_id, new.brand_id, new.market_id, new.game_code,',
    E'        row(new.tenant_id, new.brand_id, new.market_id, lower(new.game_code),'
  );
  if v_updated = v_definition then
    raise exception 'Ticket-side lineage code normalization could not be installed.';
  end if;

  execute v_updated;
end;
$$;

comment on function ticket_authority.bind_and_validate_ticket_lineage() is
  'Binds immutable canonical ticket lineage and compares normalized availability/Product codes without weakening exact scope, version, or hash validation.';

commit;
