create table game_engine.signing_providers (
  id uuid primary key,
  provider_id text not null,
  provider_version text not null,
  provider_type text not null,
  production_eligible boolean not null default false,
  algorithm text not null,
  key_identifier text not null,
  algorithm_version text not null,
  verification_support boolean not null default false,
  key_rotation_support boolean not null default false,
  failure_mode text not null,
  content_hash text not null,
  lifecycle_state text not null,
  signature_metadata jsonb,
  created_at timestamptz not null default now(),
  constraint ux_signing_providers_provider_version unique (provider_id, provider_version),
  constraint ux_signing_providers_content_hash unique (content_hash),
  check (provider_type in ('LOCAL_TEST', 'SOFTWARE_KEY', 'KMS', 'HSM', 'SIMULATION')),
  check (failure_mode in ('FailClosed', 'FailOpen')),
  check (lifecycle_state in ('Draft', 'Active', 'Disabled', 'Retired', 'Revoked')),
  check (content_hash like 'sha256:%'),
  check (signature_metadata is null or jsonb_typeof(signature_metadata) = 'object')
);

create table game_engine.certificate_signatures (
  signature_id uuid primary key,
  certificate_reference_type text not null,
  certificate_id uuid not null,
  provider_id text not null,
  provider_version text not null,
  algorithm text not null,
  algorithm_version text not null,
  canonical_payload_hash text not null,
  signature_value text not null,
  verification_status text not null,
  signing_context text not null default 'DryRun',
  issued_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint ux_certificate_signatures_provider_certificate_hash
    unique (provider_id, provider_version, certificate_reference_type, certificate_id, canonical_payload_hash),
  constraint ux_certificate_signatures_value unique (signature_value),
  check (certificate_reference_type in ('AuthorityCertificate', 'OutcomeCertificate', 'MathEvaluationCertificate', 'CertificationPack')),
  check (canonical_payload_hash like 'sha256:%'),
  check (signature_value like 'sha256:%'),
  check (verification_status in ('Pending', 'Verified', 'Failed', 'Revoked')),
  check (signing_context in ('DryRun', 'Simulation', 'ProductionDisabled'))
);

create index idx_signing_providers_provider_version
  on game_engine.signing_providers(provider_id, provider_version);

create index idx_signing_providers_content_hash
  on game_engine.signing_providers(content_hash);

create index idx_signing_providers_lifecycle_state
  on game_engine.signing_providers(lifecycle_state);

create index idx_certificate_signatures_provider
  on game_engine.certificate_signatures(provider_id, provider_version);

create index idx_certificate_signatures_certificate
  on game_engine.certificate_signatures(certificate_reference_type, certificate_id);

create index idx_certificate_signatures_payload_hash
  on game_engine.certificate_signatures(canonical_payload_hash);

create index idx_certificate_signatures_value
  on game_engine.certificate_signatures(signature_value);

create or replace function game_engine.validate_signing_provider()
returns trigger
language plpgsql
as $$
begin
  if new.provider_type in ('LOCAL_TEST', 'SIMULATION') and new.production_eligible then
    raise exception 'LOCAL_TEST and SIMULATION signing providers can never be production eligible';
  end if;

  if new.production_eligible then
    if new.lifecycle_state <> 'Active' then
      raise exception 'Production signing providers must be active';
    end if;

    if btrim(new.key_identifier) = '' then
      raise exception 'Production signing providers require an active key reference';
    end if;

    if not new.verification_support then
      raise exception 'Production signing providers require verification support';
    end if;

    if not new.key_rotation_support then
      raise exception 'Production signing providers require key rotation support';
    end if;

    if new.failure_mode <> 'FailClosed' then
      raise exception 'Production signing providers must fail closed';
    end if;
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_certificate_signature()
returns trigger
language plpgsql
as $$
declare
  provider record;
  expected_hash text;
begin
  if new.signing_context = 'ProductionDisabled' then
    raise exception 'Production certificate signing and verification are disabled';
  end if;

  select *
    into provider
  from game_engine.signing_providers
  where provider_id = new.provider_id
    and provider_version = new.provider_version;

  if not found then
    raise exception 'Signing provider reference is invalid';
  end if;

  if provider.lifecycle_state <> 'Active' then
    raise exception 'Signing provider must be active';
  end if;

  if provider.provider_type in ('LOCAL_TEST', 'SIMULATION') and provider.production_eligible then
    raise exception 'LOCAL_TEST and SIMULATION signing providers can never be production eligible';
  end if;

  if provider.algorithm <> new.algorithm or provider.algorithm_version <> new.algorithm_version then
    raise exception 'Signature algorithm does not match signing provider';
  end if;

  if not provider.verification_support then
    raise exception 'Signing provider must support verification';
  end if;

  if provider.failure_mode <> 'FailClosed' then
    raise exception 'Signing provider must fail closed';
  end if;

  if new.certificate_reference_type = 'AuthorityCertificate' then
    select canonical_payload_hash
      into expected_hash
    from game_engine.authority_certificates
    where certificate_id = new.certificate_id;
  elsif new.certificate_reference_type = 'OutcomeCertificate' then
    select canonical_outcome_hash
      into expected_hash
    from game_engine.outcome_certificates
    where certificate_id = new.certificate_id;
  elsif new.certificate_reference_type = 'MathEvaluationCertificate' then
    select canonical_prize_facts_hash
      into expected_hash
    from game_engine.math_evaluation_certificates
    where certificate_id = new.certificate_id;
  elsif new.certificate_reference_type = 'CertificationPack' then
    select content_hash
      into expected_hash
    from game_engine.certification_packs
    where id = new.certificate_id;
  end if;

  if expected_hash is null then
    raise exception 'Certificate reference is invalid';
  end if;

  if expected_hash <> new.canonical_payload_hash then
    raise exception 'Signature canonical payload hash does not match certificate payload hash';
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_signing_provider_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.signing_providers is append-only; create a new signing provider version instead';
end;
$$;

create or replace function game_engine.prevent_certificate_signature_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.certificate_signatures is append-only; create a new signature record instead';
end;
$$;

create trigger trg_validate_signing_provider
before insert on game_engine.signing_providers
for each row execute function game_engine.validate_signing_provider();

create trigger trg_prevent_signing_provider_update
before update on game_engine.signing_providers
for each row execute function game_engine.prevent_signing_provider_mutation();

create trigger trg_prevent_signing_provider_delete
before delete on game_engine.signing_providers
for each row execute function game_engine.prevent_signing_provider_mutation();

create trigger trg_validate_certificate_signature
before insert on game_engine.certificate_signatures
for each row execute function game_engine.validate_certificate_signature();

create trigger trg_prevent_certificate_signature_update
before update on game_engine.certificate_signatures
for each row execute function game_engine.prevent_certificate_signature_mutation();

create trigger trg_prevent_certificate_signature_delete
before delete on game_engine.certificate_signatures
for each row execute function game_engine.prevent_certificate_signature_mutation();

comment on table game_engine.signing_providers is
  'Append-only signing provider definitions for Authority Chain certificate evidence. Production providers are modeled but no production keys are enabled.';

comment on table game_engine.certificate_signatures is
  'Append-only certificate signature evidence for Authority Chain verification. Production signing context is rejected in P0-005.9.';
