create table game_engine.entropy_provider_definitions (
  id uuid primary key,
  provider_id text not null,
  provider_version text not null,
  provider_type text not null,
  platform_runtime_reference text not null,
  entropy_source_metadata jsonb not null default '{}'::jsonb,
  minimum_entropy_bits integer not null,
  health_test_capabilities jsonb not null default '[]'::jsonb,
  production_eligible boolean not null default false,
  failure_mode text not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  constraint ux_entropy_provider_definitions_provider_version unique (provider_id, provider_version),
  constraint ux_entropy_provider_definitions_content_hash unique (content_hash),
  check (provider_type in ('OS_CSPRNG', 'HARDWARE_ENTROPY', 'HYBRID', 'TEST_SIMULATION')),
  check (jsonb_typeof(entropy_source_metadata) = 'object'),
  check (jsonb_typeof(health_test_capabilities) = 'array'),
  check (minimum_entropy_bits >= 0),
  check (failure_mode in ('FailClosed', 'Disabled')),
  check (content_hash like 'sha256:%' or content_hash like 'sha384:%' or content_hash like 'sha512:%')
);

create table game_engine.csprng_provider_definitions (
  id uuid primary key,
  provider_id text not null,
  provider_version text not null,
  outcome_provider_id text not null,
  outcome_provider_version text not null,
  linked_rng_provider_id text not null,
  linked_rng_provider_version text not null,
  entropy_provider_type text not null,
  drbg_type text not null,
  hash_algorithm text not null,
  security_strength_bits integer not null,
  reseed_policy jsonb not null default '{}'::jsonb,
  session_isolation_policy jsonb not null default '{}'::jsonb,
  zeroization_policy jsonb not null default '{}'::jsonb,
  startup_self_test_supported boolean not null default false,
  known_answer_test_supported boolean not null default false,
  continuous_health_test_supported boolean not null default false,
  production_eligible boolean not null default false,
  lifecycle_state text not null,
  failure_mode text not null,
  sampling_capabilities jsonb not null default '[]'::jsonb,
  content_hash text not null,
  certification_binding text,
  created_at timestamptz not null default now(),
  constraint ux_csprng_provider_definitions_provider_version unique (provider_id, provider_version),
  constraint ux_csprng_provider_definitions_content_hash unique (content_hash),
  check (entropy_provider_type in ('OS_CSPRNG', 'HARDWARE_ENTROPY', 'HYBRID')),
  check (drbg_type = 'HMAC_DRBG'),
  check (hash_algorithm in ('SHA_256', 'SHA_384', 'SHA_512')),
  check (security_strength_bits >= 0),
  check (jsonb_typeof(reseed_policy) = 'object'),
  check (jsonb_typeof(session_isolation_policy) = 'object'),
  check (jsonb_typeof(zeroization_policy) = 'object'),
  check (lifecycle_state in ('Draft', 'Active', 'Suspended', 'Retired', 'Superseded')),
  check (failure_mode in ('FailClosed', 'Disabled')),
  check (jsonb_typeof(sampling_capabilities) = 'array'),
  check (content_hash like 'sha256:%' or content_hash like 'sha384:%' or content_hash like 'sha512:%')
);

create table game_engine.drbg_session_evidence (
  session_id uuid primary key,
  draw_request_scope text not null,
  provider_id text not null,
  provider_version text not null,
  entropy_provider_id text not null,
  entropy_provider_version text not null,
  reseed_counter bigint not null,
  personalization_string_hash text not null,
  nonce_hash text not null,
  seed_commitment_hash text not null,
  startup_self_test_result text not null,
  known_answer_test_result text not null,
  continuous_test_result text not null,
  generated_at timestamptz not null,
  destroyed_zeroized_at timestamptz not null,
  canonical_evidence_hash text not null,
  signing_metadata jsonb,
  created_at timestamptz not null default now(),
  constraint ux_drbg_session_evidence_hash unique (canonical_evidence_hash),
  check (reseed_counter >= 0),
  check (personalization_string_hash like 'sha256:%' or personalization_string_hash like 'sha384:%' or personalization_string_hash like 'sha512:%'),
  check (nonce_hash like 'sha256:%' or nonce_hash like 'sha384:%' or nonce_hash like 'sha512:%'),
  check (seed_commitment_hash like 'sha256:%' or seed_commitment_hash like 'sha384:%' or seed_commitment_hash like 'sha512:%'),
  check (startup_self_test_result in ('Passed', 'Failed', 'Missing', 'NotApplicable')),
  check (known_answer_test_result in ('Passed', 'Failed', 'Missing', 'NotApplicable')),
  check (continuous_test_result in ('Passed', 'Failed', 'Missing', 'NotApplicable')),
  check (destroyed_zeroized_at >= generated_at),
  check (canonical_evidence_hash like 'sha256:%' or canonical_evidence_hash like 'sha384:%' or canonical_evidence_hash like 'sha512:%'),
  check (signing_metadata is null or jsonb_typeof(signing_metadata) = 'object')
);

create index idx_entropy_provider_definitions_provider_version
  on game_engine.entropy_provider_definitions(provider_id, provider_version);

create index idx_entropy_provider_definitions_content_hash
  on game_engine.entropy_provider_definitions(content_hash);

create index idx_entropy_provider_definitions_type_eligible
  on game_engine.entropy_provider_definitions(provider_type, production_eligible);

create index idx_csprng_provider_definitions_provider_version
  on game_engine.csprng_provider_definitions(provider_id, provider_version);

create index idx_csprng_provider_definitions_content_hash
  on game_engine.csprng_provider_definitions(content_hash);

create index idx_csprng_provider_definitions_outcome_provider
  on game_engine.csprng_provider_definitions(outcome_provider_id, outcome_provider_version);

create index idx_csprng_provider_definitions_rng_provider
  on game_engine.csprng_provider_definitions(linked_rng_provider_id, linked_rng_provider_version);

create index idx_csprng_provider_definitions_lifecycle_eligible
  on game_engine.csprng_provider_definitions(lifecycle_state, production_eligible);

create index idx_drbg_session_evidence_provider_version
  on game_engine.drbg_session_evidence(provider_id, provider_version);

create index idx_drbg_session_evidence_entropy_provider
  on game_engine.drbg_session_evidence(entropy_provider_id, entropy_provider_version);

create index idx_drbg_session_evidence_scope
  on game_engine.drbg_session_evidence(draw_request_scope);

create index idx_drbg_session_evidence_hash
  on game_engine.drbg_session_evidence(canonical_evidence_hash);

create or replace function game_engine.jsonb_has_forbidden_secret_material(payload jsonb)
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
      if lower(item.key) like '%rawseed%'
        or lower(item.key) like '%seedmaterial%'
        or lower(item.key) like '%rawentropy%'
        or lower(item.key) like '%entropybytes%'
        or lower(item.key) like '%drbgstate%'
        or lower(item.key) like '%internalstate%'
        or lower(item.key) like '%secretstate%'
        or lower(item.key) like '%unreducedsecret%' then
        return true;
      end if;

      if game_engine.jsonb_has_forbidden_secret_material(item.value) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(payload) = 'array' then
    for item in select value from jsonb_array_elements(payload)
    loop
      if game_engine.jsonb_has_forbidden_secret_material(item.value) then
        return true;
      end if;
    end loop;
  end if;

  return false;
end;
$$;

create or replace function game_engine.validate_entropy_provider_definition()
returns trigger
language plpgsql
as $$
begin
  if new.minimum_entropy_bits < 128 then
    raise exception 'Entropy providers require at least 128 bits of declared entropy';
  end if;

  if new.production_eligible and new.provider_type = 'TEST_SIMULATION' then
    raise exception 'TEST/SIMULATION entropy providers can never be production eligible';
  end if;

  if new.production_eligible and new.failure_mode <> 'FailClosed' then
    raise exception 'Production entropy providers must fail closed';
  end if;

  if new.production_eligible and jsonb_array_length(new.health_test_capabilities) = 0 then
    raise exception 'Production entropy providers require health-test capabilities';
  end if;

  if game_engine.jsonb_has_forbidden_secret_material(new.entropy_source_metadata) then
    raise exception 'Raw entropy, seed material, and DRBG state must never be persisted';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_csprng_provider_definition()
returns trigger
language plpgsql
as $$
declare
  outcome_provider record;
  rng_provider record;
begin
  select *
    into outcome_provider
  from game_engine.outcome_provider_definitions
  where provider_id = new.outcome_provider_id
    and provider_version = new.outcome_provider_version;

  if not found then
    raise exception 'Certified CSPRNG contract references an unknown Outcome Provider version';
  end if;

  if outcome_provider.provider_type <> 'CERTIFIED_CSPRNG' then
    raise exception 'Certified CSPRNG contract must reference a CERTIFIED_CSPRNG Outcome Provider';
  end if;

  select *
    into rng_provider
  from game_engine.rng_provider_definitions
  where provider_id = new.linked_rng_provider_id
    and provider_version = new.linked_rng_provider_version;

  if not found then
    raise exception 'Certified CSPRNG contract references an unknown RNG Provider version';
  end if;

  if new.security_strength_bits < 128 then
    raise exception 'Certified CSPRNG providers require at least 128-bit security strength';
  end if;

  if new.production_eligible and rng_provider.production_eligible is not true then
    raise exception 'Production Certified CSPRNG providers require a production-eligible linked RNG Provider';
  end if;

  if new.production_eligible and new.failure_mode <> 'FailClosed' then
    raise exception 'Production Certified CSPRNG providers must fail closed';
  end if;

  if new.production_eligible and (
    new.startup_self_test_supported is not true
    or new.known_answer_test_supported is not true
    or new.continuous_health_test_supported is not true
  ) then
    raise exception 'Production Certified CSPRNG providers require startup, KAT, and continuous health tests';
  end if;

  if new.production_eligible
    and not (new.sampling_capabilities ?& array[
      'RejectionSampling',
      'FisherYatesShuffle',
      'UniqueNumberSelection',
      'IntegerRationalWeightedSelection'
    ]) then
    raise exception 'Production Certified CSPRNG providers require unbiased sampling capabilities';
  end if;

  if game_engine.jsonb_has_forbidden_secret_material(new.reseed_policy)
    or game_engine.jsonb_has_forbidden_secret_material(new.session_isolation_policy)
    or game_engine.jsonb_has_forbidden_secret_material(new.zeroization_policy) then
    raise exception 'Raw entropy, seed material, and DRBG state must never be persisted';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_drbg_session_evidence()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from game_engine.csprng_provider_definitions
    where provider_id = new.provider_id
      and provider_version = new.provider_version
  ) then
    raise exception 'DRBG session evidence references an unknown Certified CSPRNG provider version';
  end if;

  if not exists (
    select 1
    from game_engine.entropy_provider_definitions
    where provider_id = new.entropy_provider_id
      and provider_version = new.entropy_provider_version
  ) then
    raise exception 'DRBG session evidence references an unknown entropy provider version';
  end if;

  if new.startup_self_test_result in ('Failed', 'Missing')
    or new.known_answer_test_result in ('Failed', 'Missing')
    or new.continuous_test_result in ('Failed', 'Missing') then
    raise exception 'DRBG session evidence requires passing startup, KAT, and continuous tests';
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_certified_csprng_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Certified CSPRNG governance tables are append-only; create a new version or evidence row instead';
end;
$$;

create trigger trg_validate_entropy_provider_definition
before insert on game_engine.entropy_provider_definitions
for each row execute function game_engine.validate_entropy_provider_definition();

create trigger trg_prevent_entropy_provider_update
before update on game_engine.entropy_provider_definitions
for each row execute function game_engine.prevent_certified_csprng_mutation();

create trigger trg_prevent_entropy_provider_delete
before delete on game_engine.entropy_provider_definitions
for each row execute function game_engine.prevent_certified_csprng_mutation();

create trigger trg_validate_csprng_provider_definition
before insert on game_engine.csprng_provider_definitions
for each row execute function game_engine.validate_csprng_provider_definition();

create trigger trg_prevent_csprng_provider_update
before update on game_engine.csprng_provider_definitions
for each row execute function game_engine.prevent_certified_csprng_mutation();

create trigger trg_prevent_csprng_provider_delete
before delete on game_engine.csprng_provider_definitions
for each row execute function game_engine.prevent_certified_csprng_mutation();

create trigger trg_validate_drbg_session_evidence
before insert on game_engine.drbg_session_evidence
for each row execute function game_engine.validate_drbg_session_evidence();

create trigger trg_prevent_drbg_session_evidence_update
before update on game_engine.drbg_session_evidence
for each row execute function game_engine.prevent_certified_csprng_mutation();

create trigger trg_prevent_drbg_session_evidence_delete
before delete on game_engine.drbg_session_evidence
for each row execute function game_engine.prevent_certified_csprng_mutation();

comment on table game_engine.entropy_provider_definitions is
  'Append-only entropy provider definitions for certified CSPRNG governance. Raw entropy, seeds, and DRBG state are intentionally absent and rejected from metadata.';

comment on table game_engine.csprng_provider_definitions is
  'Append-only certified CSPRNG provider contracts linking exact Outcome Provider and RNG Provider versions. Production authority remains disabled.';

comment on table game_engine.drbg_session_evidence is
  'Append-only DRBG session evidence containing hashes, health-test results, and zeroization evidence only. Raw seed, entropy, and internal DRBG state are never stored.';
