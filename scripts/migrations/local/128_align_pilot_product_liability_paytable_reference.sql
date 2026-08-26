begin;

do $$
declare
  v_identity regprocedure :=
    'ticket_authority.calculate_theoretical_liability(uuid,uuid,jsonb)'::regprocedure;
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(v_identity) into v_definition;

  v_updated := replace(
    v_definition,
    E'  if not found or v_paytable.version <> v_product_version.paytable_version then',
    E'  if not found or v_product_version.paytable_version not in (\n    v_paytable.version,\n    v_paytable.paytable_id || '':'' || v_paytable.version\n  ) then'
  );
  if v_updated = v_definition then
    raise exception 'Pilot product compact paytable reference compatibility could not be installed.';
  end if;

  execute v_updated;
end;
$$;

comment on function ticket_authority.calculate_theoretical_liability(uuid,uuid,jsonb) is
  'Calculates canonical ticket liability from exact immutable paytable lineage, accepting the established compact paytable-id:version product reference without relaxing identity or lifecycle checks.';

commit;
