create table game_engine.canonical_draw_execution_leases (
  draw_id uuid primary key,
  lease_token uuid not null unique,
  owner_reference text not null,
  status text not null check (status in ('ACTIVE', 'RELEASED', 'EXPIRED')),
  acquired_at timestamptz not null,
  expires_at timestamptz not null,
  released_at timestamptz,
  canonical_lease_hash text not null check (canonical_lease_hash like 'sha256:%'),
  check (expires_at > acquired_at),
  check (
    (status = 'ACTIVE' and released_at is null)
    or (status in ('RELEASED', 'EXPIRED') and released_at is not null)
  )
);

create index idx_canonical_draw_execution_leases_active
  on game_engine.canonical_draw_execution_leases(expires_at)
  where status = 'ACTIVE';

create table game_engine.canonical_draw_orchestration_events (
  orchestration_event_id uuid primary key,
  draw_id uuid not null,
  lease_token uuid,
  event_type text not null check (
    event_type in (
      'LEASE_ACQUIRED',
      'LEASE_RELEASED',
      'LEASE_EXPIRED',
      'SETTLEMENT_ACKNOWLEDGED',
      'DRAW_COMPLETED'
    )
  ),
  evidence_reference text not null,
  canonical_evidence_hash text not null check (canonical_evidence_hash like 'sha256:%'),
  created_at timestamptz not null default now(),
  constraint ux_canonical_draw_orchestration_event
    unique (draw_id, event_type, evidence_reference)
);

create index idx_canonical_draw_orchestration_events_draw
  on game_engine.canonical_draw_orchestration_events(draw_id, created_at, orchestration_event_id);

create table game_engine.outcome_settlement_acknowledgements (
  settlement_acknowledgement_id uuid primary key,
  settlement_request_id uuid not null
    references game_engine.outcome_settlement_requests(settlement_request_id),
  outcome_version_id uuid not null
    references game_engine.canonical_outcome_versions(outcome_version_id),
  consumption_id uuid not null
    references game_engine.outcome_settlement_consumptions(consumption_id),
  settlement_authority_request_id uuid not null
    references settlement_service.settlement_requests(settlement_request_id),
  authoritative_settlement_id uuid not null
    references settlement_service.authoritative_settlement_records(settlement_id),
  canonical_settlement_hash text not null check (canonical_settlement_hash like 'sha256:%'),
  acknowledgement_status text not null check (acknowledgement_status = 'ACKNOWLEDGED'),
  canonical_acknowledgement_hash text not null check (canonical_acknowledgement_hash like 'sha256:%'),
  acknowledged_at timestamptz not null default now(),
  constraint ux_outcome_settlement_acknowledgements_request unique (settlement_request_id),
  constraint ux_outcome_settlement_acknowledgements_consumption unique (consumption_id),
  constraint ux_outcome_settlement_acknowledgements_authority_record
    unique (authoritative_settlement_id)
);

create index idx_outcome_settlement_acknowledgements_version
  on game_engine.outcome_settlement_acknowledgements(outcome_version_id, acknowledged_at);

alter table game_engine.canonical_draw_completion_evidence
  add column settlement_acknowledgement_id uuid
    references game_engine.outcome_settlement_acknowledgements(settlement_acknowledgement_id);

create unique index ux_canonical_draw_completion_acknowledgement
  on game_engine.canonical_draw_completion_evidence(settlement_acknowledgement_id)
  where settlement_acknowledgement_id is not null;

create or replace function game_engine.prevent_canonical_orchestration_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only; % is not allowed.', tg_table_name, tg_op;
end;
$$;

create or replace function game_engine.claim_canonical_draw_execution_lease(
  p_draw_id uuid,
  p_lease_token uuid,
  p_owner_reference text,
  p_lease_duration interval
)
returns boolean
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_existing game_engine.canonical_draw_execution_leases%rowtype;
  v_hash text;
begin
  if p_draw_id is null or p_lease_token is null then
    raise exception 'Draw id and lease token are required.';
  end if;
  if p_owner_reference is null or btrim(p_owner_reference) = '' then
    raise exception 'Execution lease owner is required.';
  end if;
  if p_lease_duration is null or p_lease_duration <= interval '0 seconds' then
    raise exception 'Execution lease duration must be positive.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('canonical-draw-lease:' || p_draw_id::text, 0));
  select * into v_existing
  from game_engine.canonical_draw_execution_leases
  where draw_id = p_draw_id
  for update;

  if found and v_existing.status = 'ACTIVE' and v_existing.expires_at > v_now then
    return false;
  end if;

  if found and v_existing.status = 'ACTIVE' then
    update game_engine.canonical_draw_execution_leases
    set status = 'EXPIRED', released_at = v_now
    where draw_id = p_draw_id;

    insert into game_engine.canonical_draw_orchestration_events (
      orchestration_event_id, draw_id, lease_token, event_type,
      evidence_reference, canonical_evidence_hash, created_at)
    values (
      gen_random_uuid(), p_draw_id, v_existing.lease_token, 'LEASE_EXPIRED',
      v_existing.lease_token::text,
      'sha256:' || encode(digest(
        p_draw_id::text || '|' || v_existing.lease_token::text || '|LEASE_EXPIRED',
        'sha256'), 'hex'),
      v_now)
    on conflict (draw_id, event_type, evidence_reference) do nothing;
  end if;

  v_hash := 'sha256:' || encode(digest(
    p_draw_id::text || '|' || p_lease_token::text || '|' || p_owner_reference || '|' || v_now::text,
    'sha256'), 'hex');

  insert into game_engine.canonical_draw_execution_leases (
    draw_id, lease_token, owner_reference, status, acquired_at, expires_at,
    released_at, canonical_lease_hash)
  values (
    p_draw_id, p_lease_token, btrim(p_owner_reference), 'ACTIVE', v_now,
    v_now + p_lease_duration, null, v_hash)
  on conflict (draw_id) do update set
    lease_token = excluded.lease_token,
    owner_reference = excluded.owner_reference,
    status = excluded.status,
    acquired_at = excluded.acquired_at,
    expires_at = excluded.expires_at,
    released_at = excluded.released_at,
    canonical_lease_hash = excluded.canonical_lease_hash;

  insert into game_engine.canonical_draw_orchestration_events (
    orchestration_event_id, draw_id, lease_token, event_type,
    evidence_reference, canonical_evidence_hash, created_at)
  values (
    gen_random_uuid(), p_draw_id, p_lease_token, 'LEASE_ACQUIRED',
    p_lease_token::text, v_hash, v_now);

  return true;
end;
$$;

create or replace function game_engine.release_canonical_draw_execution_lease(
  p_draw_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_updated integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('canonical-draw-lease:' || p_draw_id::text, 0));
  update game_engine.canonical_draw_execution_leases
  set status = 'RELEASED', released_at = v_now
  where draw_id = p_draw_id
    and lease_token = p_lease_token
    and status = 'ACTIVE';
  get diagnostics v_updated = row_count;

  if v_updated = 1 then
    insert into game_engine.canonical_draw_orchestration_events (
      orchestration_event_id, draw_id, lease_token, event_type,
      evidence_reference, canonical_evidence_hash, created_at)
    values (
      gen_random_uuid(), p_draw_id, p_lease_token, 'LEASE_RELEASED',
      p_lease_token::text,
      'sha256:' || encode(digest(
        p_draw_id::text || '|' || p_lease_token::text || '|LEASE_RELEASED',
        'sha256'), 'hex'),
      v_now)
    on conflict (draw_id, event_type, evidence_reference) do nothing;
  end if;

  return v_updated = 1;
end;
$$;

create or replace function game_engine.validate_outcome_settlement_acknowledgement()
returns trigger
language plpgsql
as $$
declare
  v_evidence record;
begin
  select
    request.outcome_version_id,
    request.settlement_input_id,
    consumption.settlement_request_id,
    authority_record.settlement_request_id as authority_request_id,
    authority_record.settlement_input_id as authority_input_id,
    authority_record.canonical_settlement_hash
  into v_evidence
  from game_engine.outcome_settlement_requests request
  join game_engine.outcome_settlement_consumptions consumption
    on consumption.consumption_id = new.consumption_id
  join settlement_service.authoritative_settlement_records authority_record
    on authority_record.settlement_id = new.authoritative_settlement_id
  where request.settlement_request_id = new.settlement_request_id;

  if v_evidence is null
     or v_evidence.outcome_version_id <> new.outcome_version_id
     or v_evidence.settlement_request_id <> new.settlement_request_id
     or v_evidence.authority_request_id <> new.settlement_authority_request_id
     or v_evidence.authority_input_id is distinct from v_evidence.settlement_input_id
     or v_evidence.canonical_settlement_hash <> new.canonical_settlement_hash then
    raise exception 'Settlement acknowledgement does not match authoritative Settlement evidence.';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_canonical_draw_completion()
returns trigger
language plpgsql
as $$
declare
  evidence_record record;
begin
  if new.settlement_acknowledgement_id is null then
    raise exception 'Draw completion requires authoritative Settlement acknowledgement.';
  end if;

  select
    version.draw_id,
    version.version_kind,
    acknowledgement.outcome_version_id,
    acknowledgement.settlement_request_id,
    acknowledgement.consumption_id,
    acknowledgement.acknowledgement_status
  into evidence_record
  from game_engine.outcome_settlement_acknowledgements acknowledgement
  join game_engine.canonical_outcome_versions version
    on version.outcome_version_id = acknowledgement.outcome_version_id
  where acknowledgement.settlement_acknowledgement_id = new.settlement_acknowledgement_id;

  if evidence_record is null
     or evidence_record.acknowledgement_status <> 'ACKNOWLEDGED'
     or evidence_record.draw_id <> new.draw_id
     or evidence_record.version_kind <> new.completion_kind
     or evidence_record.outcome_version_id <> new.outcome_version_id
     or evidence_record.settlement_request_id <> new.settlement_request_id
     or evidence_record.consumption_id <> new.consumption_id then
    raise exception 'Draw completion does not match authoritative Settlement acknowledgement.';
  end if;

  return new;
end;
$$;

create trigger trg_validate_outcome_settlement_acknowledgement
before insert on game_engine.outcome_settlement_acknowledgements
for each row execute function game_engine.validate_outcome_settlement_acknowledgement();

create trigger trg_prevent_outcome_settlement_acknowledgement_update
before update on game_engine.outcome_settlement_acknowledgements
for each row execute function game_engine.prevent_canonical_orchestration_event_mutation();

create trigger trg_prevent_outcome_settlement_acknowledgement_delete
before delete on game_engine.outcome_settlement_acknowledgements
for each row execute function game_engine.prevent_canonical_orchestration_event_mutation();

create trigger trg_prevent_canonical_draw_orchestration_event_update
before update on game_engine.canonical_draw_orchestration_events
for each row execute function game_engine.prevent_canonical_orchestration_event_mutation();

create trigger trg_prevent_canonical_draw_orchestration_event_delete
before delete on game_engine.canonical_draw_orchestration_events
for each row execute function game_engine.prevent_canonical_orchestration_event_mutation();

comment on table game_engine.canonical_draw_execution_leases is
  'Canonical Draw Orchestrator coordination state. Exactly one expiring execution lease may own a draw.';

comment on table game_engine.canonical_draw_orchestration_events is
  'Append-only lease, acknowledgement, and completion evidence for the single canonical draw orchestration path.';

comment on table game_engine.outcome_settlement_acknowledgements is
  'Append-only acknowledgement binding a canonical Settlement request to an immutable authoritative SettlementRecord.';
