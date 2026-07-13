create table if not exists game_engine.cryptographic_conformance_reports (
  report_id uuid primary key,
  subject_type text not null,
  subject_id text not null,
  subject_version text not null,
  subject_content_hash text not null,
  checks_evaluated text[] not null,
  status text not null,
  blockers jsonb not null default '[]'::jsonb,
  test_vectors jsonb not null default '{}'::jsonb,
  provider_evidence jsonb not null default '{}'::jsonb,
  provenance jsonb not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  canonical_report_hash text not null,
  signing_metadata jsonb,
  production_authority_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  constraint ux_cryptographic_conformance_reports_hash unique (canonical_report_hash),
  check (subject_type in ('CertifiedCsprng', 'ProvablyFair', 'OutcomeProvider', 'EntropyProvider', 'SigningProvider')),
  check (subject_content_hash like 'sha256:%'),
  check (cardinality(checks_evaluated) > 0),
  check (status in ('Pass', 'Fail', 'Inconclusive')),
  check (jsonb_typeof(blockers) = 'array'),
  check (jsonb_typeof(test_vectors) = 'object'),
  check (jsonb_typeof(provider_evidence) = 'object'),
  check (jsonb_typeof(provenance) = 'object'),
  check (completed_at >= started_at),
  check (canonical_report_hash like 'sha256:%'),
  check (signing_metadata is null or jsonb_typeof(signing_metadata) = 'object'),
  check (production_authority_enabled = false)
);

create table if not exists game_engine.statistical_validation_framework_reports (
  report_id uuid primary key,
  suite_type text not null,
  target_type text not null,
  target_id text not null,
  target_version text not null,
  target_content_hash text not null,
  manifest_id text,
  manifest_version text,
  algorithm_version text not null,
  sample_size bigint not null,
  configuration jsonb not null default '{}'::jsonb,
  statistical_summary jsonb not null default '{}'::jsonb,
  status text not null,
  blockers jsonb not null default '[]'::jsonb,
  provenance jsonb not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  canonical_report_hash text not null,
  signing_metadata jsonb,
  external_report_imported boolean not null default false,
  production_authority_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  constraint ux_statistical_validation_framework_reports_hash unique (canonical_report_hash),
  check (suite_type in (
    'Frequency',
    'ChiSquare',
    'Runs',
    'SerialCorrelation',
    'Distribution',
    'Variance',
    'Mean',
    'EntropyEstimate',
    'CollisionRate',
    'Uniformity',
    'Independence',
    'BiasDetection',
    'WeightedSelection',
    'FisherYatesShuffle',
    'OutcomeDslPrimitive',
    'RtpSimulation',
    'PrizeDistribution',
    'ExternalImported'
  )),
  check (target_type in ('OutcomeProvider', 'EntropyProvider', 'CertifiedCsprng', 'ProvablyFair', 'ExternalOfficial', 'PhysicalDraw', 'SigningProvider')),
  check (target_content_hash like 'sha256:%'),
  check (sample_size > 0),
  check (jsonb_typeof(configuration) = 'object'),
  check (jsonb_typeof(statistical_summary) = 'object'),
  check (status in ('Pass', 'Fail', 'Inconclusive')),
  check (jsonb_typeof(blockers) = 'array'),
  check (jsonb_typeof(provenance) = 'object'),
  check (completed_at >= started_at),
  check (canonical_report_hash like 'sha256:%'),
  check (signing_metadata is null or jsonb_typeof(signing_metadata) = 'object'),
  check (production_authority_enabled = false)
);

create table if not exists game_engine.provider_validation_registry (
  registry_entry_id uuid primary key,
  provider_type text not null,
  provider_id text not null,
  provider_version text not null,
  validation_version text not null,
  implementation_hash text not null,
  configuration_hash text not null,
  validation_status text not null,
  validation_date timestamptz not null,
  operator text not null,
  evidence_hashes text[] not null,
  canonical_registry_hash text not null,
  production_authority_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  constraint ux_provider_validation_registry_hash unique (canonical_registry_hash),
  constraint ux_provider_validation_registry_version unique (provider_type, provider_id, provider_version, validation_version, implementation_hash, configuration_hash),
  check (provider_type in ('OutcomeProvider', 'EntropyProvider', 'CertifiedCsprng', 'ProvablyFair', 'ExternalOfficial', 'PhysicalDraw', 'SigningProvider')),
  check (implementation_hash like 'sha256:%'),
  check (configuration_hash like 'sha256:%'),
  check (validation_status in ('Pass', 'Fail', 'Inconclusive')),
  check (cardinality(evidence_hashes) > 0),
  check (canonical_registry_hash like 'sha256:%'),
  check (production_authority_enabled = false)
);

create table if not exists game_engine.certification_readiness_evaluations (
  evaluation_id uuid primary key,
  target_type text not null,
  target_id text not null,
  target_version text not null,
  readiness_status text not null,
  statistical_validation_passed boolean not null,
  cryptographic_conformance_passed boolean not null,
  required_evidence_complete boolean not null,
  provider_health_passed boolean not null,
  runtime_readiness_passed boolean not null,
  guardrails_passed boolean not null,
  provider_approved boolean not null,
  outcome_authority_disabled boolean not null,
  blockers jsonb not null default '[]'::jsonb,
  evidence_hashes text[] not null,
  provenance jsonb not null,
  evaluated_at timestamptz not null,
  canonical_evaluation_hash text not null,
  production_authority_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  constraint ux_certification_readiness_evaluations_hash unique (canonical_evaluation_hash),
  check (target_type in ('OutcomeProvider', 'EntropyProvider', 'CertifiedCsprng', 'ProvablyFair', 'ExternalOfficial', 'PhysicalDraw', 'SigningProvider')),
  check (readiness_status in ('NotValidated', 'StatisticallyValidated', 'CryptographicallyConformant', 'CertificationReady', 'ProductionEligible')),
  check (jsonb_typeof(blockers) = 'array'),
  check (cardinality(evidence_hashes) > 0),
  check (jsonb_typeof(provenance) = 'object'),
  check (canonical_evaluation_hash like 'sha256:%'),
  check (production_authority_enabled = false)
);

create index if not exists idx_crypto_conformance_subject
  on game_engine.cryptographic_conformance_reports(subject_type, subject_id, subject_version);

create index if not exists idx_crypto_conformance_status
  on game_engine.cryptographic_conformance_reports(status);

create index if not exists idx_crypto_conformance_hash
  on game_engine.cryptographic_conformance_reports(canonical_report_hash);

create index if not exists idx_statistical_framework_target
  on game_engine.statistical_validation_framework_reports(target_type, target_id, target_version);

create index if not exists idx_statistical_framework_suite_target
  on game_engine.statistical_validation_framework_reports(suite_type, target_type, target_content_hash);

create index if not exists idx_statistical_framework_status
  on game_engine.statistical_validation_framework_reports(status);

create index if not exists idx_provider_validation_registry_provider
  on game_engine.provider_validation_registry(provider_type, provider_id, provider_version);

create index if not exists idx_provider_validation_registry_status
  on game_engine.provider_validation_registry(validation_status);

create index if not exists idx_certification_readiness_target
  on game_engine.certification_readiness_evaluations(target_type, target_id, target_version);

create index if not exists idx_certification_readiness_status
  on game_engine.certification_readiness_evaluations(readiness_status);

create or replace function game_engine.validate_outcome_validation_hashes(hash_values text[])
returns boolean
language plpgsql
immutable
as $$
declare
  value text;
begin
  foreach value in array hash_values loop
    if value is null or value not like 'sha256:%' then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

create or replace function game_engine.validate_outcome_validation_provenance(payload jsonb)
returns boolean
language plpgsql
immutable
as $$
begin
  return payload ? 'gitCommitSha'
    and payload ? 'semanticVersion'
    and payload ? 'buildNumber'
    and payload ? 'compilerRuntimeVersion'
    and payload ? 'implementationHash'
    and payload ? 'configurationHash'
    and payload->>'implementationHash' like 'sha256:%'
    and payload->>'configurationHash' like 'sha256:%';
end;
$$;

create or replace function game_engine.validate_cryptographic_conformance_report()
returns trigger
language plpgsql
as $$
begin
  if not game_engine.validate_outcome_validation_provenance(new.provenance) then
    raise exception 'Cryptographic conformance provenance is incomplete';
  end if;

  if new.status = 'Pass' and jsonb_array_length(new.blockers) > 0 then
    raise exception 'Passing cryptographic conformance cannot include blockers';
  end if;

  if new.status <> 'Pass' and jsonb_array_length(new.blockers) = 0 then
    raise exception 'Failed or inconclusive cryptographic conformance requires blockers';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_statistical_validation_framework_report()
returns trigger
language plpgsql
as $$
begin
  if not game_engine.validate_outcome_validation_provenance(new.provenance) then
    raise exception 'Statistical validation provenance is incomplete';
  end if;

  if new.status = 'Pass' and jsonb_array_length(new.blockers) > 0 then
    raise exception 'Passing statistical validation cannot include blockers';
  end if;

  if new.status <> 'Pass' and jsonb_array_length(new.blockers) = 0 then
    raise exception 'Failed or inconclusive statistical validation requires blockers';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_provider_validation_registry_entry()
returns trigger
language plpgsql
as $$
begin
  if not game_engine.validate_outcome_validation_hashes(new.evidence_hashes) then
    raise exception 'Provider validation evidence hashes must be sha256 hashes';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_certification_readiness_evaluation()
returns trigger
language plpgsql
as $$
begin
  if not game_engine.validate_outcome_validation_provenance(new.provenance) then
    raise exception 'Certification readiness provenance is incomplete';
  end if;

  if not game_engine.validate_outcome_validation_hashes(new.evidence_hashes) then
    raise exception 'Certification readiness evidence hashes must be sha256 hashes';
  end if;

  if new.readiness_status = 'ProductionEligible'
     and not (
       new.statistical_validation_passed
       and new.cryptographic_conformance_passed
       and new.required_evidence_complete
       and new.provider_health_passed
       and new.runtime_readiness_passed
       and new.guardrails_passed
       and new.provider_approved
       and new.outcome_authority_disabled
       and jsonb_array_length(new.blockers) = 0
     ) then
    raise exception 'Production eligibility requires all independent readiness checks to pass while Outcome Authority remains disabled';
  end if;

  if new.outcome_authority_disabled = false then
    raise exception 'P0-007.11 cannot enable production Outcome Authority';
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_outcome_validation_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Outcome validation evidence is append-only; create new evidence instead';
end;
$$;

create trigger trg_validate_cryptographic_conformance_report
before insert on game_engine.cryptographic_conformance_reports
for each row execute function game_engine.validate_cryptographic_conformance_report();

create trigger trg_prevent_cryptographic_conformance_report_update
before update on game_engine.cryptographic_conformance_reports
for each row execute function game_engine.prevent_outcome_validation_evidence_mutation();

create trigger trg_prevent_cryptographic_conformance_report_delete
before delete on game_engine.cryptographic_conformance_reports
for each row execute function game_engine.prevent_outcome_validation_evidence_mutation();

create trigger trg_validate_statistical_validation_framework_report
before insert on game_engine.statistical_validation_framework_reports
for each row execute function game_engine.validate_statistical_validation_framework_report();

create trigger trg_prevent_statistical_validation_framework_report_update
before update on game_engine.statistical_validation_framework_reports
for each row execute function game_engine.prevent_outcome_validation_evidence_mutation();

create trigger trg_prevent_statistical_validation_framework_report_delete
before delete on game_engine.statistical_validation_framework_reports
for each row execute function game_engine.prevent_outcome_validation_evidence_mutation();

create trigger trg_validate_provider_validation_registry_entry
before insert on game_engine.provider_validation_registry
for each row execute function game_engine.validate_provider_validation_registry_entry();

create trigger trg_prevent_provider_validation_registry_update
before update on game_engine.provider_validation_registry
for each row execute function game_engine.prevent_outcome_validation_evidence_mutation();

create trigger trg_prevent_provider_validation_registry_delete
before delete on game_engine.provider_validation_registry
for each row execute function game_engine.prevent_outcome_validation_evidence_mutation();

create trigger trg_validate_certification_readiness_evaluation
before insert on game_engine.certification_readiness_evaluations
for each row execute function game_engine.validate_certification_readiness_evaluation();

create trigger trg_prevent_certification_readiness_update
before update on game_engine.certification_readiness_evaluations
for each row execute function game_engine.prevent_outcome_validation_evidence_mutation();

create trigger trg_prevent_certification_readiness_delete
before delete on game_engine.certification_readiness_evaluations
for each row execute function game_engine.prevent_outcome_validation_evidence_mutation();

comment on table game_engine.cryptographic_conformance_reports is
  'Append-only cryptographic conformance evidence for Outcome Authority providers. Production activation remains disabled.';

comment on table game_engine.statistical_validation_framework_reports is
  'Append-only statistical validation framework evidence, including internal suites and external report imports.';

comment on table game_engine.provider_validation_registry is
  'Immutable provider validation registry for permanent provider-version validation history.';

comment on table game_engine.certification_readiness_evaluations is
  'Append-only certification and production eligibility evaluations. Production eligibility does not activate Outcome Authority.';
