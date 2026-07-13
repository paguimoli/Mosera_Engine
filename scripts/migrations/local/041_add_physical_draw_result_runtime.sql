create table game_engine.physical_draw_authorities (
  id uuid primary key,
  authority_id text not null,
  authority_version text not null,
  authority_name text not null,
  authority_type text not null check (authority_type in ('GOVERNMENT_LOTTERY', 'REGULATOR', 'LICENSED_OPERATOR', 'INDEPENDENT_SUPERVISOR')),
  country text not null,
  jurisdiction text null,
  operator text not null,
  facility text not null,
  draw_machine_identifier text not null,
  ball_set_identifier text not null,
  approved_procedures_version text not null,
  supported_game_identifiers jsonb not null,
  supported_result_schemas jsonb not null,
  witness_policy jsonb not null,
  timestamp_policy jsonb not null,
  production_eligible boolean not null default false,
  lifecycle_state text not null check (lifecycle_state in ('Draft', 'Active', 'Suspended', 'Retired', 'Superseded', 'Revoked')),
  failure_mode text not null check (failure_mode in ('FailClosed', 'Disabled')),
  content_hash text not null,
  certification_binding text null,
  created_at timestamptz not null default now(),
  constraint ux_physical_draw_authorities_version unique (authority_id, authority_version),
  constraint ux_physical_draw_authorities_hash unique (content_hash),
  constraint ck_physical_draw_authorities_hash check (content_hash like 'sha256:%'),
  constraint ck_physical_draw_authorities_games check (jsonb_typeof(supported_game_identifiers) = 'array' and jsonb_array_length(supported_game_identifiers) > 0),
  constraint ck_physical_draw_authorities_schemas check (jsonb_typeof(supported_result_schemas) = 'array' and jsonb_array_length(supported_result_schemas) > 0)
);

create table game_engine.physical_draw_events (
  draw_event_id uuid primary key,
  idempotency_key text not null,
  draw_identifier text not null,
  provider_id text not null,
  provider_version text not null,
  authority_id text not null,
  authority_version text not null,
  manifest_id text not null,
  manifest_version text not null,
  game_identifier text not null,
  draw_timestamp timestamptz not null,
  scheduled_timestamp timestamptz not null,
  received_timestamp timestamptz not null,
  schema_type text not null check (schema_type in ('UNIQUE_NUMBER_SET', 'ORDERED_NUMBER_SEQUENCE', 'BONUS_NUMBER_SET', 'SUPPLEMENTARY_NUMBER_SET', 'COMPOSITE')),
  normalized_payload jsonb not null,
  canonical_result_hash text not null,
  winning_numbers jsonb not null default '[]'::jsonb,
  bonus_numbers jsonb not null default '[]'::jsonb,
  alternate_balls jsonb not null default '[]'::jsonb,
  equipment_references jsonb not null,
  machine_id text not null,
  ball_set_id text not null,
  draw_operator text not null,
  witness_references jsonb not null,
  media_references jsonb not null default '[]'::jsonb,
  video_hash text null,
  image_hash text null,
  official_report_reference text not null,
  procedural_evidence_hash text not null,
  custody_state text not null check (custody_state in ('Received', 'WitnessVerified', 'EquipmentVerified', 'AuthorityVerified', 'Normalized', 'Certified', 'Disputed', 'Superseded', 'Rejected')),
  content_hash text not null,
  created_at timestamptz not null default now(),
  constraint ux_physical_draw_events_idempotency unique (authority_id, authority_version, draw_identifier, idempotency_key),
  constraint ux_physical_draw_events_draw_hash unique (authority_id, authority_version, provider_id, provider_version, draw_identifier, canonical_result_hash),
  constraint ux_physical_draw_events_hash unique (content_hash),
  constraint ck_physical_draw_events_hashes check (canonical_result_hash like 'sha256:%' and content_hash like 'sha256:%' and procedural_evidence_hash like 'sha256:%'),
  constraint ck_physical_draw_events_equipment check (jsonb_typeof(equipment_references) = 'array' and jsonb_array_length(equipment_references) > 0)
);

create table game_engine.physical_draw_witnesses (
  witness_event_id uuid primary key,
  draw_event_id uuid not null,
  authority_id text not null,
  authority_version text not null,
  witness_role text not null check (witness_role in ('OPERATOR', 'PRIMARY', 'SECONDARY', 'REGULATOR', 'DIGITAL_APPROVAL', 'MANUAL_CERTIFICATION')),
  witness_reference text not null,
  evidence_hash text not null,
  created_at timestamptz not null default now(),
  constraint ux_physical_draw_witnesses_hash unique (evidence_hash),
  constraint ck_physical_draw_witnesses_hash check (evidence_hash like 'sha256:%')
);

create table game_engine.physical_draw_equipment (
  equipment_event_id uuid primary key,
  draw_event_id uuid not null,
  authority_id text not null,
  authority_version text not null,
  equipment_id text not null,
  equipment_type text not null check (equipment_type in ('DRAW_MACHINE', 'BALL_SET', 'SEAL', 'CALIBRATION_DEVICE', 'INSPECTION_RECORD')),
  equipment_version text not null,
  lifecycle_state text not null check (lifecycle_state in ('Active', 'Suspended', 'Retired', 'Revoked')),
  inspection_reference text not null,
  maintenance_reference text not null,
  calibration_reference text not null,
  seal_reference text not null,
  approved boolean not null,
  evidence_hash text not null,
  created_at timestamptz not null default now(),
  constraint ux_physical_draw_equipment_hash unique (evidence_hash),
  constraint ck_physical_draw_equipment_hash check (evidence_hash like 'sha256:%')
);

create table game_engine.physical_draw_evidence (
  evidence_id uuid primary key,
  draw_event_id uuid not null,
  authority_id text not null,
  authority_version text not null,
  provider_id text not null,
  provider_version text not null,
  draw_identifier text not null,
  verification_status text not null check (verification_status in ('Pending', 'Verified', 'Rejected', 'Conflict', 'SupersessionRequired')),
  custody_state text not null check (custody_state in ('Received', 'WitnessVerified', 'EquipmentVerified', 'AuthorityVerified', 'Normalized', 'Certified', 'Disputed', 'Superseded', 'Rejected')),
  canonical_result_hash text not null,
  event_content_hash text not null,
  failure_code text null,
  failure_reason text null,
  evidence_hash text not null,
  verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint ux_physical_draw_evidence_hash unique (evidence_hash),
  constraint ck_physical_draw_evidence_hashes check (canonical_result_hash like 'sha256:%' and event_content_hash like 'sha256:%' and evidence_hash like 'sha256:%')
);

create unique index ux_physical_draw_events_one_certified_draw
  on game_engine.physical_draw_events(authority_id, authority_version, provider_id, provider_version, draw_identifier)
  where custody_state = 'Certified';
create index idx_physical_draw_authorities_lifecycle
  on game_engine.physical_draw_authorities(lifecycle_state, production_eligible);
create index idx_physical_draw_events_authority_draw
  on game_engine.physical_draw_events(authority_id, authority_version, draw_identifier);
create index idx_physical_draw_evidence_authority_draw
  on game_engine.physical_draw_evidence(authority_id, authority_version, provider_id, provider_version, draw_identifier);
create index idx_physical_draw_witnesses_event
  on game_engine.physical_draw_witnesses(draw_event_id);
create index idx_physical_draw_equipment_event
  on game_engine.physical_draw_equipment(draw_event_id);

create or replace function game_engine.prevent_physical_draw_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Physical draw result runtime evidence is append-only';
end;
$$;

create or replace function game_engine.validate_physical_draw_authority()
returns trigger
language plpgsql
as $$
begin
  if new.production_eligible and new.failure_mode <> 'FailClosed' then
    raise exception 'Production-eligible physical draw authorities must fail closed';
  end if;

  if new.production_eligible and new.lifecycle_state <> 'Active' then
    raise exception 'Production-eligible physical draw authorities must be active';
  end if;

  if coalesce((new.witness_policy->>'minimumWitnessCount')::int, 0) < 1 then
    raise exception 'Physical draw authority must require at least one witness';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_physical_draw_event()
returns trigger
language plpgsql
as $$
declare
  authority record;
  provider record;
  max_clock_skew int;
  max_draw_age int;
  witness_count int;
begin
  select * into authority
  from game_engine.physical_draw_authorities
  where authority_id = new.authority_id
    and authority_version = new.authority_version;

  if authority is null then
    raise exception 'Physical draw authority is unknown';
  end if;

  if authority.lifecycle_state <> 'Active' then
    raise exception 'Physical draw authority is not active';
  end if;

  if authority.failure_mode <> 'FailClosed' then
    raise exception 'Physical draw authority must fail closed';
  end if;

  select * into provider
  from game_engine.outcome_provider_definitions
  where provider_id = new.provider_id
    and provider_version = new.provider_version;

  if provider is null or provider.provider_type <> 'PHYSICAL_DRAW_RESULT' then
    raise exception 'Physical draw event requires a Physical Draw Result provider';
  end if;

  if provider.capability_markers->>'generatesOutcomes' = 'true'
    or provider.capability_markers->>'ingestsExternalOutcomes' <> 'true'
    or provider.capability_markers->>'supportsPhysicalDrawEvidence' <> 'true' then
    raise exception 'Physical draw provider capability markers are invalid';
  end if;

  if not (authority.supported_game_identifiers ? new.game_identifier) then
    raise exception 'Physical draw authority does not support the supplied game identifier';
  end if;

  if not (authority.supported_result_schemas ? new.schema_type) then
    raise exception 'Physical draw authority does not support the supplied result schema';
  end if;

  if authority.draw_machine_identifier <> new.machine_id then
    raise exception 'Physical draw machine does not match approved authority equipment';
  end if;

  if authority.ball_set_identifier <> new.ball_set_id then
    raise exception 'Physical draw ball set does not match approved authority equipment';
  end if;

  if new.witness_references::text ~* '(rtp|paytable|payout|settlement|ledger|wallet|cashier|money|secret|credential|password|token|api_key)' then
    raise exception 'Physical draw witness evidence contains forbidden fields';
  end if;

  witness_count := 0;
  if length(coalesce(new.witness_references->>'OperatorIdentity', new.witness_references->>'operatorIdentity', '')) > 0 then
    witness_count := witness_count + 1;
  end if;
  if length(coalesce(new.witness_references->>'PrimaryWitness', new.witness_references->>'primaryWitness', '')) > 0 then
    witness_count := witness_count + 1;
  end if;
  if length(coalesce(new.witness_references->>'SecondaryWitness', new.witness_references->>'secondaryWitness', '')) > 0 then
    witness_count := witness_count + 1;
  end if;
  if length(coalesce(new.witness_references->>'RegulatorWitness', new.witness_references->>'regulatorWitness', '')) > 0 then
    witness_count := witness_count + 1;
  end if;

  if coalesce((authority.witness_policy->>'operatorRequired')::boolean, true)
    and length(coalesce(new.witness_references->>'OperatorIdentity', new.witness_references->>'operatorIdentity', '')) = 0 then
    raise exception 'Physical draw operator witness is required';
  end if;

  if coalesce((authority.witness_policy->>'primaryWitnessRequired')::boolean, true)
    and length(coalesce(new.witness_references->>'PrimaryWitness', new.witness_references->>'primaryWitness', '')) = 0 then
    raise exception 'Physical draw primary witness is required';
  end if;

  if coalesce((authority.witness_policy->>'secondaryWitnessRequired')::boolean, false)
    and length(coalesce(new.witness_references->>'SecondaryWitness', new.witness_references->>'secondaryWitness', '')) = 0 then
    raise exception 'Physical draw secondary witness is required';
  end if;

  if coalesce((authority.witness_policy->>'regulatorWitnessRequired')::boolean, false)
    and length(coalesce(new.witness_references->>'RegulatorWitness', new.witness_references->>'regulatorWitness', '')) = 0 then
    raise exception 'Physical draw regulator witness is required';
  end if;

  if witness_count < coalesce((authority.witness_policy->>'minimumWitnessCount')::int, 1) then
    raise exception 'Physical draw event does not satisfy minimum witness count';
  end if;

  if new.normalized_payload::text ~* '(rtp|paytable|payout|settlement|ledger|wallet|cashier|money)' then
    raise exception 'Physical draw result payload contains forbidden financial fields';
  end if;

  if new.equipment_references::text !~ '"Approved"\s*:\s*true'
    and new.equipment_references::text !~ '"approved"\s*:\s*true' then
    raise exception 'Physical draw equipment must be approved';
  end if;

  if new.equipment_references::text ~ '"LifecycleState"\s*:\s*"Retired"'
    or new.equipment_references::text ~ '"lifecycleState"\s*:\s*"Retired"'
    or new.equipment_references::text ~ '"LifecycleState"\s*:\s*"Revoked"'
    or new.equipment_references::text ~ '"lifecycleState"\s*:\s*"Revoked"' then
    raise exception 'Physical draw retired or revoked equipment is rejected';
  end if;

  max_clock_skew := coalesce((authority.timestamp_policy->>'maxClockSkewSeconds')::int, 300);
  if coalesce((authority.timestamp_policy->>'futureTimestampsRejected')::boolean, true)
    and new.draw_timestamp > now() + make_interval(secs => max_clock_skew) then
    raise exception 'Physical draw timestamp is future-dated beyond policy';
  end if;

  max_draw_age := nullif((authority.timestamp_policy->>'maxDrawAgeSeconds')::int, 0);
  if max_draw_age is not null and new.draw_timestamp < now() - make_interval(secs => max_draw_age) then
    raise exception 'Physical draw timestamp is stale under policy';
  end if;

  if new.received_timestamp < new.draw_timestamp then
    raise exception 'Physical draw received timestamp cannot precede draw timestamp';
  end if;

  if exists (
    select 1
    from game_engine.physical_draw_events existing
    where existing.authority_id = new.authority_id
      and existing.authority_version = new.authority_version
      and existing.provider_id = new.provider_id
      and existing.provider_version = new.provider_version
      and existing.draw_identifier = new.draw_identifier
      and existing.canonical_result_hash <> new.canonical_result_hash
      and existing.custody_state = 'Certified'
  ) then
    raise exception 'Physical draw result conflict requires governed supersession';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_physical_draw_witness()
returns trigger
language plpgsql
as $$
begin
  if new.witness_reference ~* '(secret|credential|password|token|api_key)' then
    raise exception 'Physical draw witness reference must not contain secrets';
  end if;
  return new;
end;
$$;

create or replace function game_engine.validate_physical_draw_equipment()
returns trigger
language plpgsql
as $$
begin
  if not new.approved or new.lifecycle_state <> 'Active' then
    raise exception 'Physical draw equipment must be approved and active';
  end if;
  return new;
end;
$$;

create or replace function game_engine.validate_physical_draw_evidence()
returns trigger
language plpgsql
as $$
begin
  if new.verification_status in ('Conflict', 'SupersessionRequired') and new.custody_state <> 'Disputed' then
    raise exception 'Physical draw conflict or supersession evidence must be disputed';
  end if;

  if new.verification_status = 'Verified' and new.custody_state <> 'Certified' then
    raise exception 'Verified physical draw evidence must be certified';
  end if;

  return new;
end;
$$;

create trigger trg_validate_physical_draw_authority
before insert on game_engine.physical_draw_authorities
for each row execute function game_engine.validate_physical_draw_authority();
create trigger trg_prevent_physical_draw_authority_update
before update on game_engine.physical_draw_authorities
for each row execute function game_engine.prevent_physical_draw_mutation();
create trigger trg_prevent_physical_draw_authority_delete
before delete on game_engine.physical_draw_authorities
for each row execute function game_engine.prevent_physical_draw_mutation();

create trigger trg_validate_physical_draw_event
before insert on game_engine.physical_draw_events
for each row execute function game_engine.validate_physical_draw_event();
create trigger trg_prevent_physical_draw_event_update
before update on game_engine.physical_draw_events
for each row execute function game_engine.prevent_physical_draw_mutation();
create trigger trg_prevent_physical_draw_event_delete
before delete on game_engine.physical_draw_events
for each row execute function game_engine.prevent_physical_draw_mutation();

create trigger trg_validate_physical_draw_witness
before insert on game_engine.physical_draw_witnesses
for each row execute function game_engine.validate_physical_draw_witness();
create trigger trg_prevent_physical_draw_witness_update
before update on game_engine.physical_draw_witnesses
for each row execute function game_engine.prevent_physical_draw_mutation();
create trigger trg_prevent_physical_draw_witness_delete
before delete on game_engine.physical_draw_witnesses
for each row execute function game_engine.prevent_physical_draw_mutation();

create trigger trg_validate_physical_draw_equipment
before insert on game_engine.physical_draw_equipment
for each row execute function game_engine.validate_physical_draw_equipment();
create trigger trg_prevent_physical_draw_equipment_update
before update on game_engine.physical_draw_equipment
for each row execute function game_engine.prevent_physical_draw_mutation();
create trigger trg_prevent_physical_draw_equipment_delete
before delete on game_engine.physical_draw_equipment
for each row execute function game_engine.prevent_physical_draw_mutation();

create trigger trg_validate_physical_draw_evidence
before insert on game_engine.physical_draw_evidence
for each row execute function game_engine.validate_physical_draw_evidence();
create trigger trg_prevent_physical_draw_evidence_update
before update on game_engine.physical_draw_evidence
for each row execute function game_engine.prevent_physical_draw_mutation();
create trigger trg_prevent_physical_draw_evidence_delete
before delete on game_engine.physical_draw_evidence
for each row execute function game_engine.prevent_physical_draw_mutation();

create or replace function game_engine.validate_outcome_runtime_attempt()
returns trigger
language plpgsql
as $$
begin
  if new.mode = 'Production' and new.status = 'Accepted' then
    raise exception 'Production outcome runtime attempts cannot be accepted while production authority remains disabled';
  end if;

  if new.status = 'Accepted'
    and new.provider_type in ('CERTIFIED_CSPRNG', 'PROVABLY_FAIR')
    and new.mode in ('DryRun', 'Simulation') then
    return new;
  end if;

  if new.status = 'Accepted'
    and new.provider_type in ('EXTERNAL_OFFICIAL_RESULT', 'PHYSICAL_DRAW_RESULT')
    and new.mode in ('DryRun', 'Simulation') then
    return new;
  end if;

  if new.status = 'Accepted' then
    raise exception 'Only dry-run/simulation CSPRNG, Provably Fair, External Official Result, or Physical Draw Result attempts can be accepted while production authority remains disabled';
  end if;

  return new;
end;
$$;

comment on table game_engine.physical_draw_authorities is
  'Append-only approved physical draw authority definitions for supervised physical draw result ingestion.';
comment on table game_engine.physical_draw_events is
  'Append-only physical draw events normalized into outcome evidence; no randomness or financial effects.';
comment on table game_engine.physical_draw_evidence is
  'Append-only physical draw custody and verification evidence.';
