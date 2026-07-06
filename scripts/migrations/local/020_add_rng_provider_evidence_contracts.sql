create table game_engine.rng_provider_definitions (
  id uuid primary key,
  provider_id text not null,
  provider_version text not null,
  provider_type text not null,
  production_eligible boolean not null default false,
  certification_state text not null default 'None',
  algorithm_references jsonb not null default '[]'::jsonb,
  entropy_source_metadata jsonb not null default '{}'::jsonb,
  health_test_capabilities jsonb not null default '[]'::jsonb,
  failure_mode text not null,
  content_hash text not null,
  signature_metadata jsonb,
  created_at timestamptz not null default now(),
  constraint ux_rng_provider_definitions_provider_version unique (provider_id, provider_version),
  constraint ux_rng_provider_definitions_content_hash unique (content_hash),
  check (provider_type in ('OS_CSPRNG', 'HMAC_DRBG', 'CTR_DRBG', 'HASH_DRBG', 'HARDWARE_ENTROPY', 'TEST_DETERMINISTIC', 'SIMULATION')),
  check (certification_state in ('None', 'InternalVerified', 'LabSubmitted', 'Certified')),
  check (failure_mode in ('FailClosed', 'DegradedReadOnly', 'Disabled')),
  check (jsonb_typeof(algorithm_references) = 'array'),
  check (jsonb_typeof(entropy_source_metadata) = 'object'),
  check (jsonb_typeof(health_test_capabilities) = 'array'),
  check (signature_metadata is null or jsonb_typeof(signature_metadata) = 'object')
);

create table game_engine.rng_provider_evidence (
  evidence_id uuid primary key,
  provider_id text not null,
  provider_version text not null,
  entropy_source_reference text not null,
  health_test_result text not null,
  known_answer_test_result text not null,
  continuous_test_result text not null,
  generated_at timestamptz not null,
  canonical_evidence_hash text not null,
  signing_metadata jsonb,
  created_at timestamptz not null default now(),
  constraint ux_rng_provider_evidence_hash unique (canonical_evidence_hash),
  check (health_test_result in ('NotApplicable', 'Passed', 'Failed', 'Missing')),
  check (known_answer_test_result in ('NotApplicable', 'Passed', 'Failed', 'Missing')),
  check (continuous_test_result in ('NotApplicable', 'Passed', 'Failed', 'Missing')),
  check (signing_metadata is null or jsonb_typeof(signing_metadata) = 'object')
);

create index idx_rng_provider_definitions_provider_version
  on game_engine.rng_provider_definitions(provider_id, provider_version);

create index idx_rng_provider_definitions_content_hash
  on game_engine.rng_provider_definitions(content_hash);

create index idx_rng_provider_definitions_production_eligible
  on game_engine.rng_provider_definitions(production_eligible);

create index idx_rng_provider_evidence_provider_version
  on game_engine.rng_provider_evidence(provider_id, provider_version);

create index idx_rng_provider_evidence_hash
  on game_engine.rng_provider_evidence(canonical_evidence_hash);

create or replace function game_engine.validate_rng_provider_definition()
returns trigger
language plpgsql
as $$
begin
  if jsonb_array_length(new.algorithm_references) = 0 then
    raise exception 'rng_provider_definitions.algorithm_references must contain at least one algorithm reference';
  end if;

  if new.production_eligible and new.provider_type in ('TEST_DETERMINISTIC', 'SIMULATION') then
    raise exception 'TEST_DETERMINISTIC and SIMULATION RNG providers can never be production eligible';
  end if;

  if new.production_eligible and jsonb_array_length(new.health_test_capabilities) = 0 then
    raise exception 'Production-eligible RNG providers require health-test capabilities';
  end if;

  if new.production_eligible and new.failure_mode <> 'FailClosed' then
    raise exception 'Production-eligible RNG providers must fail closed';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_rng_provider_evidence()
returns trigger
language plpgsql
as $$
begin
  if new.health_test_result in ('Failed', 'Missing') then
    raise exception 'RNG provider evidence requires passing health-test evidence';
  end if;

  if new.continuous_test_result in ('Failed', 'Missing') then
    raise exception 'RNG provider evidence requires passing continuous-test evidence';
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_rng_provider_definition_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.rng_provider_definitions is append-only; create a new RNG provider version instead';
end;
$$;

create or replace function game_engine.prevent_rng_provider_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.rng_provider_evidence is append-only; create new evidence instead';
end;
$$;

create trigger trg_validate_rng_provider_definition
before insert on game_engine.rng_provider_definitions
for each row execute function game_engine.validate_rng_provider_definition();

create trigger trg_prevent_rng_provider_definition_update
before update on game_engine.rng_provider_definitions
for each row execute function game_engine.prevent_rng_provider_definition_mutation();

create trigger trg_prevent_rng_provider_definition_delete
before delete on game_engine.rng_provider_definitions
for each row execute function game_engine.prevent_rng_provider_definition_mutation();

create trigger trg_validate_rng_provider_evidence
before insert on game_engine.rng_provider_evidence
for each row execute function game_engine.validate_rng_provider_evidence();

create trigger trg_prevent_rng_provider_evidence_update
before update on game_engine.rng_provider_evidence
for each row execute function game_engine.prevent_rng_provider_evidence_mutation();

create trigger trg_prevent_rng_provider_evidence_delete
before delete on game_engine.rng_provider_evidence
for each row execute function game_engine.prevent_rng_provider_evidence_mutation();

comment on table game_engine.rng_provider_definitions is
  'Append-only production RNG provider contracts. Deterministic test and simulation providers can never be production eligible; production-eligible providers require health-test capability and fail-closed behavior.';

comment on table game_engine.rng_provider_evidence is
  'Append-only RNG provider health and evidence records. Production outcome generation remains disabled until a future outcome pipeline consumes this evidence and fails closed when evidence is missing.';
