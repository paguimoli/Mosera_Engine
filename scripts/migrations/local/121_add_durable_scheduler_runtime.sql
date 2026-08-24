begin;

create table game_engine.durable_scheduler_product_sequences (
  product_code text primary key,
  next_public_draw_number bigint not null check (next_public_draw_number > 0),
  updated_at timestamptz not null default now()
);

create table game_engine.durable_scheduler_draws (
  draw_id uuid primary key references game_engine.draw_schedules(id) on delete restrict,
  product_id uuid not null references game_engine.game_definitions(id) on delete restrict,
  product_version_id uuid not null references game_engine.game_definition_versions(id) on delete restrict,
  product_code text not null,
  schedule_version_id uuid not null
    references game_engine.published_draw_schedule_versions(schedule_version_id) on delete restrict,
  public_draw_number bigint not null check (public_draw_number > 0),
  sales_open_at timestamptz not null,
  cutoff_at timestamptz not null,
  scheduled_execution_at timestamptz not null,
  draw_identity_hash text not null check (draw_identity_hash like 'sha256:%'),
  scheduler_state text not null check (scheduler_state in (
    'Scheduled', 'Accepting', 'Cutoff', 'ExecutionDue', 'Executing',
    'AwaitingCertification', 'AuthoritativeResult', 'SettlementTriggered',
    'Completed', 'RecoveryRequired', 'SkippedNoWagers', 'Failed', 'Cancelled'
  )),
  recovery_deadline_at timestamptz not null,
  materialized_at timestamptz not null,
  authoritative_result_at timestamptz,
  settlement_requested_at timestamptz,
  wallet_available_at timestamptz,
  constraint ux_durable_scheduler_product_draw_number unique (product_code, public_draw_number),
  constraint ux_durable_scheduler_slot unique (schedule_version_id, scheduled_execution_at),
  constraint ux_durable_scheduler_identity unique (draw_identity_hash),
  constraint ck_durable_scheduler_times check (
    sales_open_at < cutoff_at
    and cutoff_at < scheduled_execution_at
    and recovery_deadline_at >= scheduled_execution_at
  )
);

create index idx_durable_scheduler_due
  on game_engine.durable_scheduler_draws(scheduler_state, scheduled_execution_at);
create index idx_durable_scheduler_product_time
  on game_engine.durable_scheduler_draws(product_code, scheduled_execution_at);
create index idx_durable_scheduler_unsettled
  on game_engine.durable_scheduler_draws(authoritative_result_at, settlement_requested_at)
  where authoritative_result_at is not null;

create table game_engine.durable_scheduler_events (
  event_id uuid primary key,
  draw_id uuid not null references game_engine.durable_scheduler_draws(draw_id) on delete restrict,
  previous_state text,
  scheduler_state text not null,
  reason_code text not null,
  owner_id text not null,
  evidence_hash text not null unique check (evidence_hash like 'sha256:%'),
  occurred_at timestamptz not null
);

create index idx_durable_scheduler_events_draw
  on game_engine.durable_scheduler_events(draw_id, occurred_at, event_id);

create table game_engine.durable_scheduler_execution_leases (
  draw_id uuid primary key references game_engine.durable_scheduler_draws(draw_id) on delete restrict,
  claim_id uuid not null unique,
  owner_id text not null,
  lease_status text not null check (lease_status in ('ACTIVE', 'RELEASED', 'FAILED', 'EXPIRED')),
  claimed_at timestamptz not null,
  lease_expires_at timestamptz not null,
  attempt_number integer not null check (attempt_number > 0),
  evidence_hash text not null check (evidence_hash like 'sha256:%'),
  updated_at timestamptz not null,
  constraint ck_durable_scheduler_lease_time check (lease_expires_at >= claimed_at)
);

create table game_engine.durable_scheduler_execution_attempts (
  attempt_event_id uuid primary key default gen_random_uuid(),
  draw_id uuid not null references game_engine.durable_scheduler_draws(draw_id) on delete restrict,
  claim_id uuid not null,
  attempt_number integer not null check (attempt_number > 0),
  attempt_status text not null check (attempt_status in (
    'CLAIMED', 'AWAITING_CERTIFICATION', 'AUTHORITATIVE_RESULT',
    'SETTLEMENT_TRIGGERED', 'COMPLETED', 'RECOVERY_REQUIRED', 'FAILED'
  )),
  owner_id text not null,
  evidence_hash text not null unique check (evidence_hash like 'sha256:%'),
  occurred_at timestamptz not null,
  constraint ux_durable_scheduler_attempt_status
    unique (draw_id, attempt_number, attempt_status)
);

create index idx_durable_scheduler_attempt_recovery
  on game_engine.durable_scheduler_execution_attempts(draw_id, attempt_number desc, occurred_at desc);

create table game_engine.hot_spot_quick_pick_selections (
  selection_id uuid primary key,
  ticket_request_id uuid not null,
  idempotency_key text not null unique,
  spot_count integer not null check (spot_count between 1 and 10),
  numbers integer[] not null,
  purpose_domain text not null check (purpose_domain = 'HOT_SPOT_QUICK_PICK_V1'),
  product_version_hash text not null check (product_version_hash like 'sha256:%'),
  selection_hash text not null unique check (selection_hash like 'sha256:%'),
  generated_at timestamptz not null
);

create table game_engine.hot_spot_bullseye_evidence (
  evidence_id uuid primary key,
  draw_id uuid not null unique references game_engine.durable_scheduler_draws(draw_id) on delete restrict,
  execution_manifest_id uuid not null unique
    references game_engine.draw_execution_manifests(execution_manifest_id) on delete restrict,
  bullseye_number integer not null check (bullseye_number between 1 and 80),
  purpose_domain text not null check (purpose_domain = 'HOT_SPOT_BULLSEYE_V1'),
  primary_result_hash text not null check (primary_result_hash like 'sha256:%'),
  provider_configuration_hash text not null check (provider_configuration_hash like 'sha256:%'),
  canonical_evidence_hash text not null unique check (canonical_evidence_hash like 'sha256:%'),
  generated_at timestamptz not null
);

create table game_engine.hot_spot_multi_draw_purchases (
  purchase_id uuid primary key,
  ticket_id uuid not null unique references ticket_authority.tickets(ticket_id) on delete restrict,
  draw_count integer not null check (draw_count in (1, 5, 10, 20)),
  stake_per_draw_minor bigint not null check (stake_per_draw_minor > 0),
  total_reservation_minor bigint not null check (total_reservation_minor > 0),
  quick_pick_selection_id uuid
    references game_engine.hot_spot_quick_pick_selections(selection_id) on delete restrict,
  canonical_plan_hash text not null unique check (canonical_plan_hash like 'sha256:%'),
  created_at timestamptz not null,
  constraint ck_hot_spot_multi_draw_total
    check (total_reservation_minor = stake_per_draw_minor * draw_count)
);

create table game_engine.hot_spot_multi_draw_bindings (
  binding_id uuid primary key,
  purchase_id uuid not null
    references game_engine.hot_spot_multi_draw_purchases(purchase_id) on delete restrict,
  ticket_id uuid not null references ticket_authority.tickets(ticket_id) on delete restrict,
  draw_id uuid not null references game_engine.durable_scheduler_draws(draw_id) on delete restrict,
  sequence integer not null check (sequence > 0),
  public_draw_number bigint not null check (public_draw_number > 0),
  draw_identity_hash text not null check (draw_identity_hash like 'sha256:%'),
  binding_hash text not null unique check (binding_hash like 'sha256:%'),
  bound_at timestamptz not null,
  constraint ux_hot_spot_multi_draw_sequence unique (purchase_id, sequence),
  constraint ux_hot_spot_multi_draw_draw unique (purchase_id, draw_id)
);

create index idx_hot_spot_multi_draw_ticket
  on game_engine.hot_spot_multi_draw_bindings(ticket_id, sequence);
create index idx_hot_spot_multi_draw_draw
  on game_engine.hot_spot_multi_draw_bindings(draw_id, ticket_id);

create table game_engine.scheduler_settlement_kpi_events (
  kpi_event_id uuid primary key default gen_random_uuid(),
  draw_id uuid not null references game_engine.durable_scheduler_draws(draw_id) on delete restrict,
  ticket_id uuid,
  event_type text not null check (event_type in (
    'AUTHORITATIVE_RESULT', 'SETTLEMENT_REQUESTED', 'WALLET_AVAILABLE'
  )),
  source_reference text not null,
  occurred_at timestamptz not null,
  evidence_hash text not null unique check (evidence_hash like 'sha256:%'),
  constraint ux_scheduler_kpi_source unique (event_type, source_reference)
);

create index idx_scheduler_kpi_latency
  on game_engine.scheduler_settlement_kpi_events(draw_id, event_type, occurred_at);

create or replace function game_engine.prevent_durable_scheduler_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is immutable; % is not allowed.', tg_table_name, tg_op;
end;
$$;

create or replace function game_engine.validate_durable_scheduler_draw_update()
returns trigger
language plpgsql
as $$
begin
  if row(
    new.draw_id, new.product_id, new.product_version_id, new.product_code,
    new.schedule_version_id, new.public_draw_number, new.sales_open_at,
    new.cutoff_at, new.scheduled_execution_at, new.draw_identity_hash,
    new.recovery_deadline_at, new.materialized_at
  ) is distinct from row(
    old.draw_id, old.product_id, old.product_version_id, old.product_code,
    old.schedule_version_id, old.public_draw_number, old.sales_open_at,
    old.cutoff_at, old.scheduled_execution_at, old.draw_identity_hash,
    old.recovery_deadline_at, old.materialized_at
  ) then
    raise exception 'Durable scheduler draw identity and timing are immutable.';
  end if;
  return new;
end;
$$;

create trigger trg_validate_durable_scheduler_draw_update
before update on game_engine.durable_scheduler_draws
for each row execute function game_engine.validate_durable_scheduler_draw_update();
create trigger trg_prevent_durable_scheduler_draw_delete
before delete on game_engine.durable_scheduler_draws
for each row execute function game_engine.prevent_durable_scheduler_evidence_mutation();

create or replace function game_engine.validate_hot_spot_quick_pick()
returns trigger
language plpgsql
as $$
begin
  if cardinality(new.numbers) <> new.spot_count
     or exists (select 1 from unnest(new.numbers) number where number < 1 or number > 80)
     or (select count(distinct number) from unnest(new.numbers) number) <> new.spot_count then
    raise exception 'Hot Spot Quick Pick must contain the requested unique 1-80 selections.';
  end if;
  return new;
end;
$$;

create trigger trg_validate_hot_spot_quick_pick
before insert on game_engine.hot_spot_quick_pick_selections
for each row execute function game_engine.validate_hot_spot_quick_pick();

create or replace function game_engine.validate_hot_spot_bullseye_evidence()
returns trigger
language plpgsql
as $$
declare
  runtime_draw record;
  manifest record;
  generated record;
  configured_hash text;
begin
  select * into runtime_draw
  from game_engine.durable_scheduler_draws
  where draw_id = new.draw_id and product_code = 'HOT_SPOT_V1';
  if not found then
    raise exception 'Bullseye evidence requires an authoritative Hot Spot draw.';
  end if;

  select * into manifest
  from game_engine.draw_execution_manifests
  where execution_manifest_id = new.execution_manifest_id
    and draw_id = new.draw_id;
  if not found then
    raise exception 'Bullseye evidence does not match the draw Execution Manifest.';
  end if;

  select * into generated
  from game_engine.outcome_provider_execution_evidence
  where execution_manifest_id = new.execution_manifest_id
    and status = 'GENERATED'
    and result_hash = new.primary_result_hash;
  if not found
     or not (generated.provider_evidence_payload->'generatedNumbers' @> to_jsonb(array[new.bullseye_number])) then
    raise exception 'Bullseye must be selected from the exact certified primary 20-number result.';
  end if;

  select configuration_hash into configured_hash
  from game_engine.outcome_provider_configuration_versions
  where provider_id = manifest.outcome_provider_id
    and provider_version = manifest.outcome_provider_version
    and configuration_version = manifest.provider_configuration_version;
  if configured_hash is distinct from new.provider_configuration_hash then
    raise exception 'Bullseye evidence provider configuration hash mismatch.';
  end if;
  return new;
end;
$$;

create trigger trg_validate_hot_spot_bullseye_evidence
before insert on game_engine.hot_spot_bullseye_evidence
for each row execute function game_engine.validate_hot_spot_bullseye_evidence();

create or replace function game_engine.validate_hot_spot_multi_draw_purchase()
returns trigger
language plpgsql
as $$
declare
  ticket record;
  reservation record;
begin
  select * into ticket from ticket_authority.tickets where ticket_id = new.ticket_id;
  if not found or ticket.game_code <> 'HOT_SPOT_V1' then
    raise exception 'Multi-draw purchase requires a canonical Hot Spot ticket.';
  end if;
  select * into reservation from public.credit_reservations where id = ticket.reservation_id;
  if not found or reservation.reserved_amount < new.total_reservation_minor then
    raise exception 'Multi-draw purchase requires full upfront authoritative reservation.';
  end if;
  return new;
end;
$$;

create trigger trg_validate_hot_spot_multi_draw_purchase
before insert on game_engine.hot_spot_multi_draw_purchases
for each row execute function game_engine.validate_hot_spot_multi_draw_purchase();

create or replace function game_engine.validate_hot_spot_multi_draw_binding()
returns trigger
language plpgsql
as $$
declare
  purchase record;
  draw record;
begin
  select * into purchase
  from game_engine.hot_spot_multi_draw_purchases
  where purchase_id = new.purchase_id and ticket_id = new.ticket_id;
  if not found or new.sequence > purchase.draw_count then
    raise exception 'Multi-draw binding does not match its immutable purchase.';
  end if;
  select * into draw
  from game_engine.durable_scheduler_draws
  where draw_id = new.draw_id and product_code = 'HOT_SPOT_V1';
  if not found
     or draw.public_draw_number <> new.public_draw_number
     or draw.draw_identity_hash <> new.draw_identity_hash then
    raise exception 'Multi-draw binding requires exact authoritative Hot Spot draw identity.';
  end if;
  return new;
end;
$$;

create trigger trg_validate_hot_spot_multi_draw_binding
before insert on game_engine.hot_spot_multi_draw_bindings
for each row execute function game_engine.validate_hot_spot_multi_draw_binding();

create or replace function game_engine.durable_scheduler_advance_time(p_observed_at timestamptz)
returns integer
language plpgsql
as $$
declare
  changed_count integer;
begin
  with transitions as (
    select draw_id, scheduler_state previous_state,
      case
        when p_observed_at < sales_open_at then 'Scheduled'
        when p_observed_at < cutoff_at then 'Accepting'
        when p_observed_at < scheduled_execution_at then 'Cutoff'
        else 'ExecutionDue'
      end next_state
    from game_engine.durable_scheduler_draws
    where scheduler_state in ('Scheduled', 'Accepting', 'Cutoff')
  ), changed as (
    update game_engine.durable_scheduler_draws draw
    set scheduler_state = transition.next_state
    from transitions transition
    where draw.draw_id = transition.draw_id
      and transition.previous_state <> transition.next_state
    returning draw.draw_id, transition.previous_state, transition.next_state,
      draw.draw_identity_hash
  ), events as (
    insert into game_engine.durable_scheduler_events(
      event_id, draw_id, previous_state, scheduler_state, reason_code,
      owner_id, evidence_hash, occurred_at)
    select gen_random_uuid(), draw_id, previous_state, next_state,
      'AUTHORITATIVE_TIME_TRANSITION', 'durable-scheduler',
      'sha256:' || encode(digest(
        draw_identity_hash || '|' || previous_state || '|' || next_state || '|' || p_observed_at::text,
        'sha256'), 'hex'), p_observed_at
    from changed
  )
  select count(*) into changed_count from changed;

  update game_engine.draw_schedules schedule
  set status = case runtime.scheduler_state
    when 'Scheduled' then 'Scheduled'
    when 'Accepting' then 'SalesOpen'
    when 'Cutoff' then 'SalesClosed'
    when 'ExecutionDue' then 'AwaitingResult'
    else schedule.status
  end
  from game_engine.durable_scheduler_draws runtime
  where schedule.id = runtime.draw_id
    and runtime.scheduler_state in ('Scheduled', 'Accepting', 'Cutoff', 'ExecutionDue')
    and schedule.status <> case runtime.scheduler_state
      when 'Scheduled' then 'Scheduled'
      when 'Accepting' then 'SalesOpen'
      when 'Cutoff' then 'SalesClosed'
      when 'ExecutionDue' then 'AwaitingResult'
    end;
  return changed_count;
end;
$$;

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

  if runtime_draw.scheduler_state <> 'ExecutionDue'
     and not (
       runtime_draw.scheduler_state = 'Executing'
       and found
       and existing.lease_expires_at <= p_claimed_at
     ) then
    raise exception 'Draw state % is not execution due.', runtime_draw.scheduler_state;
  end if;

  if found and existing.lease_status = 'ACTIVE' and existing.lease_expires_at > p_claimed_at then
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
  on conflict (draw_id) do update set
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
  values (gen_random_uuid(), p_draw_id, 'ExecutionDue', 'Executing',
    'EXECUTION_CLAIM_ACQUIRED', p_owner_id,
    'sha256:' || encode(digest(next_hash || '|event', 'sha256'), 'hex'), p_claimed_at);

  return query select p_draw_id, next_claim_id, p_owner_id, 'Acquired',
    p_claimed_at, p_claimed_at + p_lease, next_attempt, next_hash;
end;
$$;

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
  attempt_status text;
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
  from game_engine.durable_scheduler_draws
  where draw_id = p_draw_id for update;
  if not found then raise exception 'Durable scheduler draw was not found.'; end if;
  select * into lease from game_engine.durable_scheduler_execution_leases where draw_id = p_draw_id;

  update game_engine.durable_scheduler_draws
  set scheduler_state = p_state,
      authoritative_result_at = case when p_state in ('AuthoritativeResult', 'SettlementTriggered', 'Completed')
        then coalesce(authoritative_result_at, p_occurred_at) else authoritative_result_at end,
      settlement_requested_at = case when p_state in ('SettlementTriggered', 'Completed')
        then coalesce(settlement_requested_at, p_occurred_at) else settlement_requested_at end
  where draw_id = p_draw_id;

  if found then
    update game_engine.durable_scheduler_execution_leases
    set lease_status = case when p_state in ('RecoveryRequired', 'Failed') then 'FAILED' else 'RELEASED' end,
      lease_expires_at = least(lease_expires_at, p_occurred_at), updated_at = p_occurred_at
    where draw_id = p_draw_id;
    attempt_status := case p_state
      when 'AwaitingCertification' then 'AWAITING_CERTIFICATION'
      when 'AuthoritativeResult' then 'AUTHORITATIVE_RESULT'
      when 'SettlementTriggered' then 'SETTLEMENT_TRIGGERED'
      when 'Completed' then 'COMPLETED'
      when 'RecoveryRequired' then 'RECOVERY_REQUIRED'
      else 'FAILED'
    end;
    insert into game_engine.durable_scheduler_execution_attempts(
      draw_id, claim_id, attempt_number, attempt_status, owner_id, evidence_hash, occurred_at)
    values (p_draw_id, lease.claim_id, lease.attempt_number, attempt_status,
      lease.owner_id, p_evidence_hash, p_occurred_at)
    on conflict (draw_id, attempt_number, attempt_status) do nothing;
  end if;
  insert into game_engine.durable_scheduler_events(
    event_id, draw_id, previous_state, scheduler_state, reason_code,
    owner_id, evidence_hash, occurred_at)
  values (gen_random_uuid(), p_draw_id, runtime_draw.scheduler_state, p_state,
    p_reason_code, coalesce(lease.owner_id, 'durable-scheduler'),
    'sha256:' || encode(digest(p_evidence_hash || '|state|' || p_state, 'sha256'), 'hex'), p_occurred_at)
  on conflict (evidence_hash) do nothing;
end;
$$;

create or replace function game_engine.capture_scheduler_outcome_kpi()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from game_engine.durable_scheduler_draws where draw_id = new.draw_id) then
    update game_engine.durable_scheduler_draws
    set scheduler_state = 'AuthoritativeResult',
      authoritative_result_at = coalesce(authoritative_result_at, new.published_at)
    where draw_id = new.draw_id
      and scheduler_state not in ('SettlementTriggered', 'Completed');
    insert into game_engine.scheduler_settlement_kpi_events(
      draw_id, event_type, source_reference, occurred_at, evidence_hash)
    values (new.draw_id, 'AUTHORITATIVE_RESULT', new.outcome_version_id::text,
      new.published_at,
      'sha256:' || encode(digest(
        new.draw_id::text || '|AUTHORITATIVE_RESULT|' || new.outcome_version_id::text || '|' || new.published_at::text,
        'sha256'), 'hex'))
    on conflict (event_type, source_reference) do nothing;
  end if;
  return new;
end;
$$;

create trigger trg_capture_scheduler_outcome_kpi
after insert on game_engine.canonical_outcome_versions
for each row execute function game_engine.capture_scheduler_outcome_kpi();

create or replace function game_engine.capture_scheduler_settlement_kpi()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from game_engine.durable_scheduler_draws where draw_id = new.draw_id) then
    update game_engine.durable_scheduler_draws
    set scheduler_state = 'SettlementTriggered',
      settlement_requested_at = coalesce(settlement_requested_at, new.emitted_at)
    where draw_id = new.draw_id;
    insert into game_engine.scheduler_settlement_kpi_events(
      draw_id, event_type, source_reference, occurred_at, evidence_hash)
    values (new.draw_id, 'SETTLEMENT_REQUESTED', new.settlement_request_id::text,
      new.emitted_at,
      'sha256:' || encode(digest(
        new.draw_id::text || '|SETTLEMENT_REQUESTED|' || new.settlement_request_id::text || '|' || new.emitted_at::text,
        'sha256'), 'hex'))
    on conflict (event_type, source_reference) do nothing;
  end if;
  return new;
end;
$$;

create trigger trg_capture_scheduler_settlement_kpi
after insert on game_engine.outcome_settlement_requests
for each row execute function game_engine.capture_scheduler_settlement_kpi();

create or replace function game_engine.capture_scheduler_wallet_kpi()
returns trigger
language plpgsql
as $$
declare
  resolved_ticket uuid;
  resolved_draw uuid;
begin
  if new.ticket_id ~ '^[0-9a-fA-F-]{36}$' then
    resolved_ticket := new.ticket_id::uuid;
    select ticket.draw_id into resolved_draw
    from ticket_authority.tickets ticket
    where ticket.ticket_id = resolved_ticket;
  end if;
  if resolved_draw is not null
     and exists (select 1 from game_engine.durable_scheduler_draws where draw_id = resolved_draw) then
    update game_engine.durable_scheduler_draws
    set wallet_available_at = coalesce(wallet_available_at, new.created_at)
    where draw_id = resolved_draw;
    insert into game_engine.scheduler_settlement_kpi_events(
      draw_id, ticket_id, event_type, source_reference, occurred_at, evidence_hash)
    values (resolved_draw, resolved_ticket, 'WALLET_AVAILABLE', new.id::text,
      new.created_at,
      'sha256:' || encode(digest(
        resolved_draw::text || '|WALLET_AVAILABLE|' || new.id::text || '|' || new.created_at::text,
        'sha256'), 'hex'))
    on conflict (event_type, source_reference) do nothing;
  end if;
  return new;
end;
$$;

create trigger trg_capture_scheduler_wallet_kpi
after insert on public.credit_settlement_applications
for each row execute function game_engine.capture_scheduler_wallet_kpi();

create view game_engine.durable_scheduler_operational_status as
select
  draw.product_code,
  count(*) as materialized_draw_count,
  count(*) filter (where draw.scheduler_state = 'Accepting') as accepting_draw_count,
  count(*) filter (where draw.scheduler_state = 'ExecutionDue') as due_but_unexecuted_count,
  count(*) filter (where draw.scheduler_state = 'RecoveryRequired') as recovery_required_count,
  count(ticket.ticket_id) filter (where ticket.status in (
    'ACCEPTED', 'AWAITING_DRAW', 'CLOSED', 'SETTLEMENT_PENDING')) as unsettled_ticket_count,
  min(draw.scheduled_execution_at) filter (where draw.scheduler_state = 'ExecutionDue') as oldest_due_draw_at,
  min(draw.authoritative_result_at) filter (
    where draw.authoritative_result_at is not null and draw.wallet_available_at is null) as oldest_unsettled_result_at,
  max(draw.scheduled_execution_at) as latest_materialized_draw_at
from game_engine.durable_scheduler_draws draw
left join ticket_authority.tickets ticket on ticket.draw_id = draw.draw_id
group by draw.product_code;

create view game_engine.scheduler_settlement_latency_evidence as
select
  result.draw_id,
  wallet.ticket_id,
  result.occurred_at authoritative_result_at,
  settlement.occurred_at settlement_requested_at,
  wallet.occurred_at wallet_available_at,
  extract(epoch from wallet.occurred_at - result.occurred_at) * 1000 latency_milliseconds
from game_engine.scheduler_settlement_kpi_events result
left join game_engine.scheduler_settlement_kpi_events settlement
  on settlement.draw_id = result.draw_id and settlement.event_type = 'SETTLEMENT_REQUESTED'
left join game_engine.scheduler_settlement_kpi_events wallet
  on wallet.draw_id = result.draw_id and wallet.event_type = 'WALLET_AVAILABLE'
where result.event_type = 'AUTHORITATIVE_RESULT';

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'durable_scheduler_events',
    'durable_scheduler_execution_attempts',
    'hot_spot_quick_pick_selections',
    'hot_spot_bullseye_evidence',
    'hot_spot_multi_draw_purchases',
    'hot_spot_multi_draw_bindings',
    'scheduler_settlement_kpi_events'
  ] loop
    execute format(
      'create trigger trg_prevent_%1$s_update before update on game_engine.%1$I for each row execute function game_engine.prevent_durable_scheduler_evidence_mutation()',
      table_name);
    execute format(
      'create trigger trg_prevent_%1$s_delete before delete on game_engine.%1$I for each row execute function game_engine.prevent_durable_scheduler_evidence_mutation()',
      table_name);
  end loop;
end;
$$;

comment on table game_engine.durable_scheduler_draws is
  'Canonical durable scheduler projection. Draw identity, authoritative UTC instant, cutoff and public sequence are immutable; every state change has append-only event evidence.';
comment on table game_engine.hot_spot_bullseye_evidence is
  'One immutable, purpose-separated Bullseye designation bound to the exact primary result and provider configuration.';
comment on table game_engine.hot_spot_quick_pick_selections is
  'Purpose-separated player-selection randomness. It is ticket input evidence and never Outcome Authority evidence.';
comment on view game_engine.scheduler_settlement_latency_evidence is
  'Durable measurement hook for authoritative-result-to-wallet-availability latency. PR-06 owns representative-load qualification.';

commit;
