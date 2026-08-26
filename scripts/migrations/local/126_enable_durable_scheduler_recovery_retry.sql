begin;

create or replace function game_engine.claim_durable_scheduler_execution(
  p_draw_id uuid,
  p_owner_id text,
  p_claimed_at timestamptz,
  p_lease interval)
returns table (
  draw_id uuid,
  claim_id uuid,
  owner_id text,
  claim_status text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  attempt_number integer,
  evidence_hash text)
language plpgsql
as $$
declare
  runtime_draw game_engine.durable_scheduler_draws%rowtype;
  existing game_engine.durable_scheduler_execution_leases%rowtype;
  next_claim_id uuid;
  next_attempt integer;
  next_hash text;
begin
  if p_owner_id is null or btrim(p_owner_id) = '' or p_lease <= interval '0 seconds' then
    raise exception 'Scheduler claim owner and positive bounded lease are required.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('durable-scheduler-execution:' || p_draw_id::text, 0));
  select * into runtime_draw
  from game_engine.durable_scheduler_draws
  where game_engine.durable_scheduler_draws.draw_id = p_draw_id
  for update;
  if not found then raise exception 'Durable scheduler draw was not found.'; end if;

  if runtime_draw.scheduler_state in (
    'AwaitingCertification', 'AuthoritativeResult', 'SettlementTriggered',
    'Completed', 'SkippedNoWagers', 'Cancelled') then
    select * into existing from game_engine.durable_scheduler_execution_leases lease where lease.draw_id = p_draw_id;
    return query select p_draw_id, coalesce(existing.claim_id, gen_random_uuid()),
      coalesce(existing.owner_id, p_owner_id), 'Duplicate',
      coalesce(existing.claimed_at, p_claimed_at), coalesce(existing.lease_expires_at, p_claimed_at),
      coalesce(existing.attempt_number, 0), coalesce(existing.evidence_hash, runtime_draw.draw_identity_hash);
    return;
  end if;

  select * into existing
  from game_engine.durable_scheduler_execution_leases lease
  where lease.draw_id = p_draw_id;

  if runtime_draw.scheduler_state not in ('ExecutionDue', 'RecoveryRequired')
     and not (
       runtime_draw.scheduler_state = 'Executing'
       and found
       and existing.lease_expires_at <= p_claimed_at
     ) then
    raise exception 'Draw state % is not execution due or recoverable.', runtime_draw.scheduler_state;
  end if;

  if runtime_draw.scheduler_state = 'Executing'
     and found
     and existing.lease_status = 'ACTIVE'
     and existing.lease_expires_at > p_claimed_at then
    return query select p_draw_id, existing.claim_id, existing.owner_id,
      case when existing.owner_id = p_owner_id then 'Duplicate' else 'Unavailable' end,
      existing.claimed_at, existing.lease_expires_at, existing.attempt_number, existing.evidence_hash;
    return;
  end if;

  next_attempt := coalesce(existing.attempt_number, 0) + 1;
  next_claim_id := gen_random_uuid();
  next_hash := 'sha256:' || encode(digest(
    p_draw_id::text || '|' || next_claim_id::text || '|' || p_owner_id || '|' || next_attempt::text || '|' || p_claimed_at::text,
    'sha256'), 'hex');
  insert into game_engine.durable_scheduler_execution_leases(
    draw_id, claim_id, owner_id, lease_status, claimed_at,
    lease_expires_at, attempt_number, evidence_hash, updated_at)
  values (
    p_draw_id, next_claim_id, p_owner_id, 'ACTIVE', p_claimed_at,
    p_claimed_at + p_lease, next_attempt, next_hash, p_claimed_at)
  on conflict on constraint durable_scheduler_execution_leases_pkey do update set
    claim_id = excluded.claim_id,
    owner_id = excluded.owner_id,
    lease_status = excluded.lease_status,
    claimed_at = excluded.claimed_at,
    lease_expires_at = excluded.lease_expires_at,
    attempt_number = excluded.attempt_number,
    evidence_hash = excluded.evidence_hash,
    updated_at = excluded.updated_at;

  update game_engine.durable_scheduler_draws
  set scheduler_state = 'Executing'
  where game_engine.durable_scheduler_draws.draw_id = p_draw_id;
  insert into game_engine.durable_scheduler_execution_attempts(
    draw_id, claim_id, attempt_number, attempt_status, owner_id, evidence_hash, occurred_at)
  values (p_draw_id, next_claim_id, next_attempt, 'CLAIMED', p_owner_id, next_hash, p_claimed_at);
  insert into game_engine.durable_scheduler_events(
    event_id, draw_id, previous_state, scheduler_state, reason_code,
    owner_id, evidence_hash, occurred_at)
  values (gen_random_uuid(), p_draw_id, runtime_draw.scheduler_state, 'Executing',
    case when runtime_draw.scheduler_state = 'RecoveryRequired'
      then 'RECOVERY_EXECUTION_CLAIM_ACQUIRED'
      else 'EXECUTION_CLAIM_ACQUIRED' end,
    p_owner_id,
    'sha256:' || encode(digest(next_hash || '|event', 'sha256'), 'hex'), p_claimed_at);

  return query select p_draw_id, next_claim_id, p_owner_id, 'Acquired',
    p_claimed_at, p_claimed_at + p_lease, next_attempt, next_hash;
end;
$$;

comment on function game_engine.claim_durable_scheduler_execution(uuid, text, timestamptz, interval) is
  'Atomically claims first execution and append-only governed recovery retries; completed authority states remain idempotent duplicates.';

commit;
