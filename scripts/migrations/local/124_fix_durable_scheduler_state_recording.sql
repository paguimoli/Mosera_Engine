begin;

create or replace function game_engine.record_durable_scheduler_state(
  p_draw_id uuid,
  p_state text,
  p_reason_code text,
  p_evidence_hash text,
  p_occurred_at timestamptz)
returns void
language plpgsql
as $$
declare
  runtime_draw game_engine.durable_scheduler_draws%rowtype;
  lease game_engine.durable_scheduler_execution_leases%rowtype;
  v_attempt_status text;
begin
  if p_state not in (
    'AwaitingCertification', 'AuthoritativeResult', 'SettlementTriggered',
    'Completed', 'RecoveryRequired', 'SkippedNoWagers', 'Failed')
     or p_evidence_hash not like 'sha256:%'
     or p_reason_code is null or btrim(p_reason_code) = '' then
    raise exception 'Invalid durable scheduler completion evidence.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('durable-scheduler-execution:' || p_draw_id::text, 0));
  select * into runtime_draw
  from game_engine.durable_scheduler_draws runtime
  where runtime.draw_id = p_draw_id for update;
  if not found then raise exception 'Durable scheduler draw was not found.'; end if;
  select * into lease
  from game_engine.durable_scheduler_execution_leases execution_lease
  where execution_lease.draw_id = p_draw_id;

  update game_engine.durable_scheduler_draws runtime
  set scheduler_state = p_state,
      authoritative_result_at = case when p_state in ('AuthoritativeResult', 'SettlementTriggered', 'Completed')
        then coalesce(runtime.authoritative_result_at, p_occurred_at) else runtime.authoritative_result_at end,
      settlement_requested_at = case when p_state in ('SettlementTriggered', 'Completed')
        then coalesce(runtime.settlement_requested_at, p_occurred_at) else runtime.settlement_requested_at end
  where runtime.draw_id = p_draw_id;

  if found then
    update game_engine.durable_scheduler_execution_leases execution_lease
    set lease_status = case when p_state in ('RecoveryRequired', 'Failed') then 'FAILED' else 'RELEASED' end,
      lease_expires_at = least(execution_lease.lease_expires_at, p_occurred_at),
      updated_at = p_occurred_at
    where execution_lease.draw_id = p_draw_id;
    v_attempt_status := case p_state
      when 'AwaitingCertification' then 'AWAITING_CERTIFICATION'
      when 'AuthoritativeResult' then 'AUTHORITATIVE_RESULT'
      when 'SettlementTriggered' then 'SETTLEMENT_TRIGGERED'
      when 'Completed' then 'COMPLETED'
      when 'RecoveryRequired' then 'RECOVERY_REQUIRED'
      else 'FAILED'
    end;
    insert into game_engine.durable_scheduler_execution_attempts(
      draw_id, claim_id, attempt_number, attempt_status, owner_id, evidence_hash, occurred_at)
    values (p_draw_id, lease.claim_id, lease.attempt_number, v_attempt_status,
      lease.owner_id, p_evidence_hash, p_occurred_at)
    on conflict on constraint ux_durable_scheduler_attempt_status do nothing;
  end if;
  insert into game_engine.durable_scheduler_events(
    event_id, draw_id, previous_state, scheduler_state, reason_code,
    owner_id, evidence_hash, occurred_at)
  values (gen_random_uuid(), p_draw_id, runtime_draw.scheduler_state, p_state,
    p_reason_code, coalesce(lease.owner_id, 'durable-scheduler'),
    'sha256:' || encode(digest(p_evidence_hash || '|state|' || p_state, 'sha256'), 'hex'), p_occurred_at)
  on conflict on constraint durable_scheduler_events_evidence_hash_key do nothing;
end;
$$;

comment on function game_engine.record_durable_scheduler_state(uuid, text, text, text, timestamptz) is
  'Records durable scheduler state and append-only attempt evidence using unambiguous identifiers and conflict constraints.';

commit;
