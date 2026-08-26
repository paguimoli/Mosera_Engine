begin;

do $$
declare
  v_record_identity regprocedure :=
    'game_engine.record_durable_scheduler_state(uuid,text,text,text,timestamp with time zone)'::regprocedure;
  v_claim_identity regprocedure :=
    'game_engine.claim_durable_scheduler_execution(uuid,text,timestamp with time zone,interval)'::regprocedure;
  v_definition text;
  v_updated text;
  v_active_block text;
  v_validation_block text;
begin
  select pg_get_functiondef(v_record_identity) into v_definition;
  v_updated := replace(
    v_definition,
    E'    on conflict on constraint ux_durable_scheduler_attempt_status do nothing;',
    E'    on conflict do nothing;'
  );
  if v_updated = v_definition then
    raise exception 'Scheduler state evidence idempotency could not be installed.';
  end if;
  execute v_updated;

  select pg_get_functiondef(v_claim_identity) into v_definition;
  v_validation_block := E'  if runtime_draw.scheduler_state not in (''ExecutionDue'', ''RecoveryRequired'')\n     and not (\n       runtime_draw.scheduler_state = ''Executing''\n       and found\n       and existing.lease_expires_at <= p_claimed_at\n     ) then\n    raise exception ''Draw state % is not execution due or recoverable.'', runtime_draw.scheduler_state;\n  end if;\n\n';
  v_active_block := E'  if runtime_draw.scheduler_state = ''Executing''\n     and found\n     and existing.lease_status = ''ACTIVE''\n     and existing.lease_expires_at > p_claimed_at then\n    return query select p_draw_id, existing.claim_id, existing.owner_id,\n      case when existing.owner_id = p_owner_id then ''Duplicate'' else ''Unavailable'' end,\n      existing.claimed_at, existing.lease_expires_at, existing.attempt_number, existing.evidence_hash;\n    return;\n  end if;\n\n';
  if position(v_validation_block in v_definition) = 0
     or position(v_active_block in v_definition) = 0 then
    raise exception 'Scheduler active-lease claim race blocks were not found.';
  end if;
  v_updated := replace(v_definition, v_validation_block || v_active_block,
    v_active_block || v_validation_block);
  if v_updated = v_definition then
    raise exception 'Scheduler active-lease claim race order could not be installed.';
  end if;
  execute v_updated;
end;
$$;

comment on function game_engine.record_durable_scheduler_state(uuid,text,text,text,timestamptz) is
  'Records append-only scheduler evidence idempotently across status and deterministic evidence uniqueness while retaining claim-backed attempts.';
comment on function game_engine.claim_durable_scheduler_execution(uuid,text,timestamptz,interval) is
  'Returns duplicate/unavailable for an active concurrent lease before evaluating expired-lease recovery eligibility.';

commit;
