create table game_engine.external_result_source_definitions (
  id uuid primary key,
  source_id text not null,
  source_version text not null,
  source_name text not null,
  source_type text not null,
  endpoint_reference_metadata jsonb not null default '{}'::jsonb,
  authentication_method text not null,
  signature_requirement text not null,
  transport_security_requirement text not null,
  supported_game_identifiers jsonb not null default '[]'::jsonb,
  supported_result_schemas jsonb not null default '[]'::jsonb,
  source_timezone text not null,
  publication_delay_policy jsonb not null default '{}'::jsonb,
  replay_retrieval_capability boolean not null default false,
  production_eligible boolean not null default false,
  lifecycle_state text not null,
  failure_mode text not null,
  content_hash text not null,
  certification_binding text,
  verification_key_id text,
  verification_algorithm_version text,
  verification_key_revoked_at timestamptz,
  supersedes_source_version text,
  created_at timestamptz not null default now(),
  constraint ux_external_result_source_definitions_version unique (source_id, source_version),
  constraint ux_external_result_source_definitions_hash unique (content_hash),
  check (source_type in ('OFFICIAL_API', 'SIGNED_FILE_FEED', 'APPROVED_OPERATOR_FEED', 'MANUAL_REGULATOR_IMPORT')),
  check (authentication_method in ('NONE', 'API_KEY_REFERENCE', 'MUTUAL_TLS', 'SIGNED_PAYLOAD', 'DETACHED_SIGNATURE', 'OPERATOR_ATTESTATION')),
  check (signature_requirement in ('NOT_REQUIRED', 'DETACHED_REQUIRED', 'SIGNED_ENVELOPE_REQUIRED')),
  check (transport_security_requirement in ('HTTPS_REQUIRED', 'MUTUAL_TLS_REQUIRED', 'OFFLINE_SIGNED_FILE')),
  check (jsonb_typeof(endpoint_reference_metadata) = 'object'),
  check (jsonb_typeof(supported_game_identifiers) = 'array'),
  check (jsonb_typeof(supported_result_schemas) = 'array'),
  check (jsonb_typeof(publication_delay_policy) = 'object'),
  check (lifecycle_state in ('Draft', 'Active', 'Suspended', 'Retired', 'Superseded', 'Revoked')),
  check (failure_mode in ('FailClosed', 'Disabled')),
  check (content_hash like 'sha256:%' or content_hash like 'sha384:%' or content_hash like 'sha512:%')
);

create table game_engine.external_result_schema_mappings (
  mapping_id uuid primary key,
  source_id text not null,
  source_version text not null,
  schema_version text not null,
  schema_type text not null,
  mapping_definition jsonb not null default '{}'::jsonb,
  lifecycle_state text not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  constraint ux_external_result_schema_mappings_version unique (source_id, source_version, schema_version, schema_type),
  constraint ux_external_result_schema_mappings_hash unique (content_hash),
  check (schema_type in ('UNIQUE_NUMBER_SET', 'ORDERED_NUMBER_SEQUENCE', 'BONUS_NUMBER_SET', 'SYMBOL_SEQUENCE', 'COMPOSITE')),
  check (jsonb_typeof(mapping_definition) = 'object'),
  check (lifecycle_state in ('Draft', 'Active', 'Suspended', 'Retired', 'Superseded')),
  check (content_hash like 'sha256:%' or content_hash like 'sha384:%' or content_hash like 'sha512:%')
);

create table game_engine.external_result_ingestion_events (
  ingestion_request_id uuid primary key,
  idempotency_key text not null,
  source_id text not null,
  source_version text not null,
  provider_id text not null,
  provider_version text not null,
  manifest_id text not null,
  manifest_version text not null,
  game_identifier text not null,
  drawing_id text not null,
  external_draw_id text not null,
  publication_timestamp timestamptz not null,
  source_timestamp timestamptz not null,
  received_timestamp timestamptz not null,
  source_payload_hash text not null,
  source_signature_hash text,
  signature_algorithm_version text not null,
  schema_version text not null,
  schema_type text not null,
  normalized_payload jsonb not null default '{}'::jsonb,
  canonical_result_hash text not null,
  transport_evidence_reference text not null,
  source_metadata_reference text not null,
  custody_state text not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  constraint ux_external_result_ingestion_idempotency unique (idempotency_key, source_id, source_version),
  constraint ux_external_result_ingestion_content_hash unique (content_hash),
  constraint ux_external_result_ingestion_draw_hash unique (source_id, source_version, provider_id, provider_version, external_draw_id, canonical_result_hash),
  constraint ux_external_result_ingestion_one_certified_draw unique (source_id, source_version, provider_id, provider_version, external_draw_id),
  check (source_payload_hash like 'sha256:%' or source_payload_hash like 'sha384:%' or source_payload_hash like 'sha512:%'),
  check (source_signature_hash is null or source_signature_hash like 'sha256:%' or source_signature_hash like 'sha384:%' or source_signature_hash like 'sha512:%'),
  check (schema_type in ('UNIQUE_NUMBER_SET', 'ORDERED_NUMBER_SEQUENCE', 'BONUS_NUMBER_SET', 'SYMBOL_SEQUENCE', 'COMPOSITE')),
  check (jsonb_typeof(normalized_payload) = 'object'),
  check (canonical_result_hash like 'sha256:%' or canonical_result_hash like 'sha384:%' or canonical_result_hash like 'sha512:%'),
  check (custody_state in ('Received', 'Authenticated', 'Verified', 'Normalized', 'Certified', 'Disputed', 'Superseded', 'Rejected')),
  check (content_hash like 'sha256:%' or content_hash like 'sha384:%' or content_hash like 'sha512:%')
);

create table game_engine.external_result_verification_evidence (
  evidence_id uuid primary key,
  ingestion_request_id uuid not null,
  source_id text not null,
  source_version text not null,
  provider_id text not null,
  provider_version text not null,
  external_draw_id text not null,
  verification_status text not null,
  custody_state text not null,
  canonical_result_hash text not null,
  source_payload_hash text not null,
  failure_code text,
  failure_reason text,
  evidence_hash text not null,
  verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint ux_external_result_verification_evidence_hash unique (evidence_hash),
  check (verification_status in ('Pending', 'Verified', 'Rejected', 'Conflict', 'SupersessionRequired')),
  check (custody_state in ('Received', 'Authenticated', 'Verified', 'Normalized', 'Certified', 'Disputed', 'Superseded', 'Rejected')),
  check (canonical_result_hash like 'sha256:%' or canonical_result_hash like 'sha384:%' or canonical_result_hash like 'sha512:%'),
  check (source_payload_hash like 'sha256:%' or source_payload_hash like 'sha384:%' or source_payload_hash like 'sha512:%'),
  check (evidence_hash like 'sha256:%' or evidence_hash like 'sha384:%' or evidence_hash like 'sha512:%')
);

create index idx_external_result_source_definitions_source_version
  on game_engine.external_result_source_definitions(source_id, source_version);

create index idx_external_result_source_definitions_lifecycle
  on game_engine.external_result_source_definitions(lifecycle_state, production_eligible);

create index idx_external_result_schema_mappings_source
  on game_engine.external_result_schema_mappings(source_id, source_version, schema_version, lifecycle_state);

create index idx_external_result_ingestion_events_source_draw
  on game_engine.external_result_ingestion_events(source_id, source_version, provider_id, provider_version, external_draw_id);

create index idx_external_result_ingestion_events_manifest
  on game_engine.external_result_ingestion_events(manifest_id, manifest_version);

create index idx_external_result_verification_evidence_source_draw
  on game_engine.external_result_verification_evidence(source_id, source_version, provider_id, provider_version, external_draw_id);

create or replace function game_engine.jsonb_has_external_result_secret(payload jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  item record;
begin
  if payload is null then
    return false;
  end if;

  if jsonb_typeof(payload) = 'object' then
    for item in select key, value from jsonb_each(payload)
    loop
      if lower(item.key) like '%secret%'
        or lower(item.key) like '%credential%'
        or lower(item.key) like '%password%'
        or lower(item.key) like '%token%'
        or lower(item.key) like '%apikey%'
        or lower(item.key) like '%api_key%' then
        return true;
      end if;

      if game_engine.jsonb_has_external_result_secret(item.value) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(payload) = 'array' then
    for item in select value from jsonb_array_elements(payload)
    loop
      if game_engine.jsonb_has_external_result_secret(item.value) then
        return true;
      end if;
    end loop;
  end if;

  return false;
end;
$$;

create or replace function game_engine.validate_external_result_source_definition()
returns trigger
language plpgsql
as $$
begin
  if jsonb_array_length(new.supported_game_identifiers) = 0 then
    raise exception 'External result source must support at least one game identifier';
  end if;

  if jsonb_array_length(new.supported_result_schemas) = 0 then
    raise exception 'External result source must support at least one result schema';
  end if;

  if new.production_eligible and new.failure_mode <> 'FailClosed' then
    raise exception 'Production-eligible external result sources must fail closed';
  end if;

  if new.production_eligible and new.lifecycle_state <> 'Active' then
    raise exception 'Production-eligible external result sources must be active';
  end if;

  if new.signature_requirement <> 'NOT_REQUIRED' and new.verification_key_id is null then
    raise exception 'Signature-required external result sources must declare a verification key reference';
  end if;

  if new.source_type = 'SIGNED_FILE_FEED' and new.signature_requirement = 'NOT_REQUIRED' then
    raise exception 'SIGNED_FILE_FEED sources must require signatures';
  end if;

  if new.source_type = 'OFFICIAL_API' and new.transport_security_requirement = 'OFFLINE_SIGNED_FILE' then
    raise exception 'OFFICIAL_API sources cannot use offline signed-file transport';
  end if;

  if game_engine.jsonb_has_forbidden_outcome_provider_field(new.endpoint_reference_metadata) then
    raise exception 'External result source metadata must not contain RTP, paytable, payout, settlement, or ledger fields';
  end if;

  if game_engine.jsonb_has_external_result_secret(new.endpoint_reference_metadata) then
    raise exception 'External result source metadata must not persist credentials or secrets';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_external_result_schema_mapping()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from game_engine.external_result_source_definitions
    where source_id = new.source_id
      and source_version = new.source_version
  ) then
    raise exception 'External result schema mapping references an unknown source version';
  end if;

  if game_engine.jsonb_has_forbidden_outcome_provider_field(new.mapping_definition)
    or game_engine.jsonb_has_external_result_secret(new.mapping_definition) then
    raise exception 'External result schema mapping must not contain financial logic or secrets';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_external_result_ingestion_event()
returns trigger
language plpgsql
as $$
declare
  source record;
  provider record;
  existing record;
  max_clock_skew_seconds integer;
  max_result_age_seconds integer;
  future_rejected boolean;
begin
  select *
    into source
  from game_engine.external_result_source_definitions
  where source_id = new.source_id
    and source_version = new.source_version;

  if not found then
    raise exception 'External result ingestion references an unknown source version';
  end if;

  if source.lifecycle_state <> 'Active' then
    raise exception 'External result ingestion requires an active source';
  end if;

  if source.verification_key_revoked_at is not null and source.verification_key_revoked_at <= new.received_timestamp then
    raise exception 'External result source verification key is revoked';
  end if;

  select *
    into provider
  from game_engine.outcome_provider_definitions
  where provider_id = new.provider_id
    and provider_version = new.provider_version;

  if not found or provider.provider_type <> 'EXTERNAL_OFFICIAL_RESULT' then
    raise exception 'External result ingestion requires an External Official Result provider';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements_text(source.supported_game_identifiers) game_identifier(value)
    where game_identifier.value = new.game_identifier
  ) then
    raise exception 'External result source does not support the supplied game identifier';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements_text(source.supported_result_schemas) result_schema(value)
    where result_schema.value = new.schema_type
  ) then
    raise exception 'External result source does not support the supplied result schema';
  end if;

  if not exists (
    select 1
    from game_engine.external_result_schema_mappings mapping
    where mapping.source_id = new.source_id
      and mapping.source_version = new.source_version
      and mapping.schema_version = new.schema_version
      and mapping.schema_type = new.schema_type
      and mapping.lifecycle_state = 'Active'
  ) then
    raise exception 'External result ingestion requires an active approved schema mapping';
  end if;

  if source.signature_requirement <> 'NOT_REQUIRED' and new.source_signature_hash is null then
    raise exception 'External result source requires signature evidence';
  end if;

  max_clock_skew_seconds := coalesce((source.publication_delay_policy ->> 'maxClockSkewSeconds')::integer, 300);
  max_result_age_seconds := nullif(source.publication_delay_policy ->> 'maxResultAgeSeconds', '')::integer;
  future_rejected := coalesce((source.publication_delay_policy ->> 'futureTimestampsRejected')::boolean, true);

  if future_rejected and new.source_timestamp > (new.received_timestamp + make_interval(secs => max_clock_skew_seconds)) then
    raise exception 'External result source timestamp is future-dated beyond policy';
  end if;

  if max_result_age_seconds is not null and new.source_timestamp < (new.received_timestamp - make_interval(secs => max_result_age_seconds)) then
    raise exception 'External result source timestamp is stale under policy';
  end if;

  if game_engine.jsonb_has_forbidden_outcome_provider_field(new.normalized_payload)
    or game_engine.jsonb_has_external_result_secret(new.normalized_payload) then
    raise exception 'External result normalized payload must not contain financial logic or secrets';
  end if;

  select *
    into existing
  from game_engine.external_result_ingestion_events
  where source_id = new.source_id
    and source_version = new.source_version
    and provider_id = new.provider_id
    and provider_version = new.provider_version
    and external_draw_id = new.external_draw_id
  limit 1;

  if found and existing.canonical_result_hash <> new.canonical_result_hash then
    raise exception 'External official result conflict requires governed supersession';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_external_result_verification_evidence()
returns trigger
language plpgsql
as $$
begin
  if new.verification_status = 'Verified' and new.custody_state <> 'Certified' then
    raise exception 'Verified external result evidence must be certified custody state';
  end if;

  if new.verification_status in ('Conflict', 'SupersessionRequired') and new.custody_state <> 'Disputed' then
    raise exception 'Conflicting external result evidence must be disputed custody state';
  end if;

  if lower(new.failure_reason) like '%secret%'
    or lower(new.failure_reason) like '%credential%'
    or lower(new.failure_reason) like '%token%' then
    raise exception 'External result evidence must not persist credentials or secrets';
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_external_result_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'External official result runtime evidence is append-only';
end;
$$;

create trigger trg_validate_external_result_source_definition
before insert on game_engine.external_result_source_definitions
for each row execute function game_engine.validate_external_result_source_definition();

create trigger trg_prevent_external_result_source_update
before update on game_engine.external_result_source_definitions
for each row execute function game_engine.prevent_external_result_mutation();

create trigger trg_prevent_external_result_source_delete
before delete on game_engine.external_result_source_definitions
for each row execute function game_engine.prevent_external_result_mutation();

create trigger trg_validate_external_result_schema_mapping
before insert on game_engine.external_result_schema_mappings
for each row execute function game_engine.validate_external_result_schema_mapping();

create trigger trg_prevent_external_result_schema_mapping_update
before update on game_engine.external_result_schema_mappings
for each row execute function game_engine.prevent_external_result_mutation();

create trigger trg_prevent_external_result_schema_mapping_delete
before delete on game_engine.external_result_schema_mappings
for each row execute function game_engine.prevent_external_result_mutation();

create trigger trg_validate_external_result_ingestion_event
before insert on game_engine.external_result_ingestion_events
for each row execute function game_engine.validate_external_result_ingestion_event();

create trigger trg_prevent_external_result_ingestion_event_update
before update on game_engine.external_result_ingestion_events
for each row execute function game_engine.prevent_external_result_mutation();

create trigger trg_prevent_external_result_ingestion_event_delete
before delete on game_engine.external_result_ingestion_events
for each row execute function game_engine.prevent_external_result_mutation();

create trigger trg_validate_external_result_verification_evidence
before insert on game_engine.external_result_verification_evidence
for each row execute function game_engine.validate_external_result_verification_evidence();

create trigger trg_prevent_external_result_verification_evidence_update
before update on game_engine.external_result_verification_evidence
for each row execute function game_engine.prevent_external_result_mutation();

create trigger trg_prevent_external_result_verification_evidence_delete
before delete on game_engine.external_result_verification_evidence
for each row execute function game_engine.prevent_external_result_mutation();

create or replace function game_engine.validate_outcome_runtime_attempt()
returns trigger
language plpgsql
as $$
begin
  if lower(new.failure_reason) like '%rawseed%'
    or lower(new.failure_reason) like '%serverseed%'
    or lower(new.lock_scope) like '%rawseed%'
    or lower(new.lock_scope) like '%serverseed%' then
    raise exception 'Outcome runtime attempt evidence must not contain raw entropy, seed material, or DRBG state';
  end if;

  if new.status = 'Accepted'
    and not (
      new.provider_type in ('CERTIFIED_CSPRNG', 'PROVABLY_FAIR', 'EXTERNAL_OFFICIAL_RESULT')
      and new.mode in ('DryRun', 'Simulation')
      and new.failure_code = 'None'
    ) then
    raise exception 'Only dry-run/simulation CSPRNG, Provably Fair, or External Official Result attempts can be accepted while production authority remains disabled';
  end if;

  if new.mode = 'Production' then
    raise exception 'Production Outcome Provider runtime generation is disabled';
  end if;

  return new;
end;
$$;

comment on table game_engine.external_result_source_definitions is
  'Append-only approved external official result source definitions. They contain metadata and verification references only, never credentials.';

comment on table game_engine.external_result_ingestion_events is
  'Append-only External Official Result ingestion events containing normalized canonical result evidence and hashes, not external credentials.';

comment on table game_engine.external_result_verification_evidence is
  'Append-only External Official Result authenticity, conflict, and custody evidence.';
