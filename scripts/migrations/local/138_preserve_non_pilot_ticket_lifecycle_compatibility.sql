begin;

do $$
declare
  v_identity regprocedure :=
    'ticket_authority.accept_ticket(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,text,text,text)'::regprocedure;
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(v_identity) into v_definition;
  v_updated := replace(
    v_definition,
    $needle$  select version.product_configuration into v_product_configuration
  from game_engine.game_definition_versions version
  where version.id = v_product.active_version_id
    and version.game_definition_id = v_product.id
    and version.publication_state = 'PUBLISHED'
    and version.activation_state = 'ACTIVE'
    and version.assignment_state = 'ASSIGNED'
    and (version.effective_from is null or version.effective_from <= clock_timestamp())
    and (version.effective_to is null or version.effective_to > clock_timestamp());
  if not found then
    raise exception 'effective immutable product configuration is required';
  end if;$needle$,
    $replacement$  select version.product_configuration into v_product_configuration
  from game_engine.game_definition_versions version
  where version.id = v_product.active_version_id
    and version.game_definition_id = v_product.id;
  if not found then
    raise exception 'exact immutable active product configuration is required';
  end if;$replacement$
  );
  if v_updated = v_definition then
    raise exception 'Non-pilot ticket lifecycle compatibility correction could not bind the active product version.';
  end if;
  execute v_updated;
end;
$$;

comment on function ticket_authority.accept_ticket(
  uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,text,text,text
) is
  'Sole ticket acceptance authority: validates immutable pilot product limits without changing existing non-pilot active-version lifecycle semantics.';

commit;
