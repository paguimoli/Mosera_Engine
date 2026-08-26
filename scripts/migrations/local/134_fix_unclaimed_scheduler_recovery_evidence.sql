begin;

do $$
declare
  v_identity regprocedure :=
    'game_engine.record_durable_scheduler_state(uuid,text,text,text,timestamp with time zone)'::regprocedure;
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(v_identity) into v_definition;

  v_updated := replace(
    v_definition,
    E'  v_attempt_status text;\n',
    E'  v_attempt_status text;\n  v_has_lease boolean := false;\n'
  );
  if v_updated = v_definition then
    raise exception 'Durable scheduler lease-presence state could not be added.';
  end if;
  v_definition := v_updated;

  v_updated := replace(
    v_definition,
    E'  where execution_lease.draw_id = p_draw_id;\n\n  update game_engine.durable_scheduler_draws runtime',
    E'  where execution_lease.draw_id = p_draw_id;\n  v_has_lease := found;\n\n  update game_engine.durable_scheduler_draws runtime'
  );
  if v_updated = v_definition then
    raise exception 'Durable scheduler lease-presence capture could not be installed.';
  end if;
  v_definition := v_updated;

  v_updated := replace(
    v_definition,
    E'  where runtime.draw_id = p_draw_id;\n\n  if found then\n',
    E'  where runtime.draw_id = p_draw_id;\n\n  if v_has_lease then\n'
  );
  if v_updated = v_definition then
    raise exception 'Durable scheduler claim-linked attempt guard could not be installed.';
  end if;

  execute v_updated;
end;
$$;

comment on function game_engine.record_durable_scheduler_state(uuid,text,text,text,timestamptz) is
  'Records append-only scheduler state evidence for every draw and claim-linked attempt evidence only when an execution lease actually exists.';

commit;
