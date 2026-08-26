begin;

do $$
declare
  v_identity regprocedure := 'ticket_authority.validate_liability_configuration()'::regprocedure;
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(v_identity) into v_definition;

  v_updated := replace(
    v_definition,
    E'         where game.code = new.scope_reference',
    E'         where lower(game.code) = new.scope_reference'
  );
  if v_updated = v_definition then
    raise exception 'Canonical game liability scope normalization could not be installed.';
  end if;

  execute v_updated;
end;
$$;

comment on function ticket_authority.validate_liability_configuration() is
  'Validates immutable liability scope configuration, including canonical lowercase lookup of case-preserving Game Definition codes.';

commit;
