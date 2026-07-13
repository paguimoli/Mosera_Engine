create table game_engine.outcome_provider_definitions (
  id uuid primary key,
  provider_id text not null,
  provider_version text not null,
  provider_type text not null,
  lifecycle_state text not null,
  production_eligible boolean not null default false,
  supported_outcome_primitive_types jsonb not null default '[]'::jsonb,
  evidence_requirements jsonb not null default '{}'::jsonb,
  health_readiness_capabilities jsonb not null default '[]'::jsonb,
  idempotency_model text not null,
  custody_support jsonb not null default '[]'::jsonb,
  signing_requirements jsonb not null default '{}'::jsonb,
  replayability_support boolean not null default false,
  failure_mode text not null,
  capability_markers jsonb not null default '{}'::jsonb,
  content_hash text not null,
  certification_binding text,
  jurisdiction_profile_references jsonb,
  created_at timestamptz not null default now(),
  constraint ux_outcome_provider_definitions_provider_version unique (provider_id, provider_version),
  constraint ux_outcome_provider_definitions_content_hash unique (content_hash),
  check (provider_type in ('CERTIFIED_CSPRNG', 'PROVABLY_FAIR', 'EXTERNAL_OFFICIAL_RESULT', 'PHYSICAL_DRAW_RESULT', 'SIMULATION_TEST')),
  check (lifecycle_state in ('Draft', 'Active', 'Suspended', 'Retired', 'Superseded')),
  check (jsonb_typeof(supported_outcome_primitive_types) = 'array'),
  check (jsonb_typeof(evidence_requirements) = 'object'),
  check (jsonb_typeof(health_readiness_capabilities) = 'array'),
  check (idempotency_model in ('PerDraw', 'PerWager', 'PerExternalResult', 'PerPhysicalDraw', 'DeterministicSimulation')),
  check (jsonb_typeof(custody_support) = 'array'),
  check (jsonb_typeof(signing_requirements) = 'object'),
  check (jsonb_typeof(capability_markers) = 'object'),
  check (jurisdiction_profile_references is null or jsonb_typeof(jurisdiction_profile_references) = 'array')
);

create index idx_outcome_provider_definitions_provider_version
  on game_engine.outcome_provider_definitions(provider_id, provider_version);

create index idx_outcome_provider_definitions_type_hash
  on game_engine.outcome_provider_definitions(provider_type, content_hash);

create index idx_outcome_provider_definitions_lifecycle_eligible
  on game_engine.outcome_provider_definitions(lifecycle_state, production_eligible);

create index idx_outcome_provider_definitions_content_hash
  on game_engine.outcome_provider_definitions(content_hash);

alter table game_engine.game_manifests
  add column outcome_provider_id text,
  add column outcome_provider_version text,
  add column provider_capability_requirements jsonb not null default '{}'::jsonb,
  add column provider_evidence_requirements jsonb not null default '{}'::jsonb,
  add column player_verification_receipt_required boolean not null default false,
  add column provider_eligibility_profile jsonb not null default '{}'::jsonb,
  add column certification_required boolean not null default false;

create index idx_game_manifests_outcome_provider_version
  on game_engine.game_manifests(outcome_provider_id, outcome_provider_version);

create or replace function game_engine.jsonb_has_forbidden_outcome_provider_field(payload jsonb)
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
      if lower(item.key) like '%rtp%'
        or lower(item.key) like '%paytable%'
        or lower(item.key) like '%payout%'
        or lower(item.key) like '%settlement%'
        or lower(item.key) like '%ledger%' then
        return true;
      end if;

      if game_engine.jsonb_has_forbidden_outcome_provider_field(item.value) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(payload) = 'array' then
    for item in select value from jsonb_array_elements(payload)
    loop
      if game_engine.jsonb_has_forbidden_outcome_provider_field(item.value) then
        return true;
      end if;
    end loop;
  end if;

  return false;
end;
$$;

create or replace function game_engine.jsonb_marker_enabled(payload jsonb, marker text)
returns boolean
language sql
immutable
as $$
  select coalesce(lower(payload ->> marker) = 'true', false);
$$;

create or replace function game_engine.validate_outcome_provider_definition()
returns trigger
language plpgsql
as $$
declare
  generates boolean;
  ingests boolean;
  receipt boolean;
  external_evidence boolean;
  physical_evidence boolean;
begin
  if new.content_hash not like 'sha256:%' then
    raise exception 'Outcome Provider content_hash must use sha256: prefix';
  end if;

  if jsonb_array_length(new.supported_outcome_primitive_types) = 0 then
    raise exception 'Outcome Provider must support at least one Outcome DSL primitive';
  end if;

  if jsonb_array_length(new.custody_support) = 0 then
    raise exception 'Outcome Provider must declare custody support';
  end if;

  if game_engine.jsonb_has_forbidden_outcome_provider_field(new.evidence_requirements)
    or game_engine.jsonb_has_forbidden_outcome_provider_field(new.signing_requirements)
    or game_engine.jsonb_has_forbidden_outcome_provider_field(new.capability_markers) then
    raise exception 'Outcome Provider must not contain RTP, paytable, payout, settlement, or ledger fields';
  end if;

  generates := game_engine.jsonb_marker_enabled(new.capability_markers, 'generatesOutcomes');
  ingests := game_engine.jsonb_marker_enabled(new.capability_markers, 'ingestsExternalOutcomes');
  receipt := game_engine.jsonb_marker_enabled(new.capability_markers, 'supportsPlayerVerificationReceipt');
  external_evidence := game_engine.jsonb_marker_enabled(new.capability_markers, 'supportsExternalSourceEvidence');
  physical_evidence := game_engine.jsonb_marker_enabled(new.capability_markers, 'supportsPhysicalDrawEvidence');

  if new.provider_type = 'SIMULATION_TEST' and new.production_eligible then
    raise exception 'SIMULATION_TEST providers can never be production eligible';
  end if;

  if new.production_eligible and new.failure_mode <> 'FailClosed' then
    raise exception 'Production-eligible Outcome Providers must fail closed';
  end if;

  if generates and ingests then
    raise exception 'Outcome Provider cannot both generate outcomes and ingest external outcomes';
  end if;

  if new.provider_type in ('CERTIFIED_CSPRNG', 'PROVABLY_FAIR', 'SIMULATION_TEST') and (not generates or ingests) then
    raise exception 'Generating Outcome Providers must generate outcomes and must not be external-ingestion-only';
  end if;

  if new.provider_type = 'EXTERNAL_OFFICIAL_RESULT' and (not ingests or generates or not external_evidence) then
    raise exception 'External official result providers must ingest external outcomes and provide external source evidence';
  end if;

  if new.provider_type = 'PHYSICAL_DRAW_RESULT' and (not ingests or generates or not physical_evidence) then
    raise exception 'Physical draw result providers must ingest physical draw outcomes and provide physical draw evidence';
  end if;

  if receipt and new.provider_type <> 'PROVABLY_FAIR' then
    raise exception 'Player verification receipts are only valid for Provably Fair providers in v1';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_game_manifest_outcome_provider_binding()
returns trigger
language plpgsql
as $$
declare
  provider record;
  required_primitive text;
begin
  if jsonb_typeof(new.provider_capability_requirements) <> 'object' then
    raise exception 'provider_capability_requirements must be a JSON object';
  end if;

  if jsonb_typeof(new.provider_evidence_requirements) <> 'object' then
    raise exception 'provider_evidence_requirements must be a JSON object';
  end if;

  if jsonb_typeof(new.provider_eligibility_profile) <> 'object' then
    raise exception 'provider_eligibility_profile must be a JSON object';
  end if;

  if game_engine.jsonb_has_forbidden_outcome_provider_field(new.provider_evidence_requirements)
    or game_engine.jsonb_has_forbidden_outcome_provider_field(new.provider_eligibility_profile) then
    raise exception 'Game Manifest provider binding must not contain RTP, paytable, payout, settlement, or ledger fields';
  end if;

  if (new.outcome_provider_id is null) <> (new.outcome_provider_version is null) then
    raise exception 'Game Manifest outcome provider binding must include both provider id and provider version';
  end if;

  if new.outcome_provider_id is null then
    return new;
  end if;

  select *
    into provider
  from game_engine.outcome_provider_definitions
  where provider_id = new.outcome_provider_id
    and provider_version = new.outcome_provider_version;

  if not found then
    raise exception 'Game Manifest outcome provider binding references an unknown provider version';
  end if;

  if (new.provider_capability_requirements ? 'requiredPrimitives')
    and jsonb_typeof(new.provider_capability_requirements -> 'requiredPrimitives') <> 'array' then
    raise exception 'provider_capability_requirements.requiredPrimitives must be an array';
  end if;

  for required_primitive in
    select jsonb_array_elements_text(coalesce(new.provider_capability_requirements -> 'requiredPrimitives', '[]'::jsonb))
  loop
    if not exists (
      select 1
      from jsonb_array_elements_text(provider.supported_outcome_primitive_types) supported(primitive)
      where supported.primitive = required_primitive
    ) then
      raise exception 'Outcome Provider does not support required primitive %', required_primitive;
    end if;
  end loop;

  if new.player_verification_receipt_required
    and not game_engine.jsonb_marker_enabled(provider.capability_markers, 'supportsPlayerVerificationReceipt') then
    raise exception 'Player verification receipt requirement is unsupported by the bound Outcome Provider';
  end if;

  if provider.provider_type = 'EXTERNAL_OFFICIAL_RESULT'
    and lower(new.game_family) not like '%external%'
    and lower(new.game_family) not like '%official%'
    and lower(new.game_family) not like '%lottery%'
    and lower(new.game_family) not like '%draw%' then
    raise exception 'External official result provider is incompatible with this game family';
  end if;

  if provider.provider_type = 'PHYSICAL_DRAW_RESULT'
    and lower(new.game_family) not like '%physical%'
    and lower(new.game_family) not like '%lottery%'
    and lower(new.game_family) not like '%draw%'
    and lower(new.game_family) not like '%promotional%' then
    raise exception 'Physical draw result provider is incompatible with this game family';
  end if;

  if (new.provider_eligibility_profile ? 'fallbackProviderId')
    or (new.provider_eligibility_profile ? 'silentFallbackProviderId') then
    raise exception 'Silent fallback Outcome Providers are not allowed';
  end if;

  if new.lifecycle_state = 'ProductionActive' then
    if provider.lifecycle_state <> 'Active' then
      raise exception 'ProductionActive manifests require an active Outcome Provider';
    end if;

    if not provider.production_eligible then
      raise exception 'ProductionActive manifests require a production-eligible Outcome Provider';
    end if;

    if provider.provider_type = 'SIMULATION_TEST' then
      raise exception 'SIMULATION_TEST providers cannot be production authority';
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_validate_outcome_provider_definition
before insert on game_engine.outcome_provider_definitions
for each row execute function game_engine.validate_outcome_provider_definition();

create trigger trg_prevent_outcome_provider_update
before update on game_engine.outcome_provider_definitions
for each row execute function game_engine.prevent_game_manifest_mutation();

create trigger trg_prevent_outcome_provider_delete
before delete on game_engine.outcome_provider_definitions
for each row execute function game_engine.prevent_game_manifest_mutation();

create trigger trg_validate_game_manifest_outcome_provider_binding
before insert on game_engine.game_manifests
for each row execute function game_engine.validate_game_manifest_outcome_provider_binding();

comment on table game_engine.outcome_provider_definitions is
  'Append-only Outcome Provider definitions above RNG Provider governance. Providers emit canonical Outcome Certificates through Outcome Authority.';
