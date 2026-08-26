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
    E'  where id = p_paytable_definition_id\n    and lifecycle_state = ''ProductionActive'';',
    E'  where id = p_paytable_definition_id\n    and (lifecycle_state = ''ProductionActive''\n      or (lifecycle_state = ''GovernanceApproved''\n        and v_product_version.publication_state = ''PUBLISHED''\n        and v_product_version.approval_state in (''INTERNAL_APPROVED'', ''EXTERNAL_APPROVED'')));'
  );
  if v_updated = v_definition then
    raise exception 'Pilot product liability lifecycle compatibility could not be installed.';
  end if;

  v_updated := replace(
    v_updated,
    E'    raise exception ''Liability requires the exact immutable ProductionActive Paytable version.'';',
    E'    raise exception ''Liability requires the exact immutable approved Paytable version.'';'
  );

  execute v_updated;
end;
$$;

comment on function ticket_authority.calculate_theoretical_liability(uuid,uuid,jsonb) is
  'Calculates canonical ticket liability from the exact immutable paytable. GovernanceApproved is accepted only for an exact published internally/externally approved product version; lineage mismatch remains fail-closed.';

commit;
