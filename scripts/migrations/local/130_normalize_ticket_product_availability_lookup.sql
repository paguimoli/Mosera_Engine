begin;

do $$
declare
  v_identity regprocedure :=
    'ticket_authority.persist_authorized_ticket(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,jsonb,text,text,text,text,text)'::regprocedure;
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(v_identity) into v_definition;

  v_updated := replace(
    v_definition,
    E'  where id = p_product_id and code = v_availability.game_code;',
    E'  where id = p_product_id and lower(code) = lower(v_availability.game_code);'
  );
  if v_updated = v_definition then
    raise exception 'Canonical ticket Product/availability code normalization could not be installed.';
  end if;

  execute v_updated;
end;
$$;

comment on function ticket_authority.persist_authorized_ticket(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,jsonb,text,text,text,text,text) is
  'Persists one immutable authorized ticket while resolving normalized availability game codes against the exact Product UUID and case-preserving canonical Product code.';

commit;
