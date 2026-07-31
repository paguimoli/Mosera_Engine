alter table game_engine.outcome_provider_definitions
  add column canonical_provider_category text;

alter table game_engine.outcome_provider_definitions
  add constraint ck_outcome_provider_canonical_category
    check (
      canonical_provider_category is null
      or canonical_provider_category in (
        'INTERNAL_CSPRNG',
        'OFFICIAL_RESULTS',
        'MANUAL_CERTIFIED'
      )
    );

insert into game_engine.outcome_provider_definitions (
  id,
  provider_id,
  provider_version,
  provider_type,
  lifecycle_state,
  production_eligible,
  supported_outcome_primitive_types,
  evidence_requirements,
  health_readiness_capabilities,
  idempotency_model,
  custody_support,
  signing_requirements,
  replayability_support,
  failure_mode,
  capability_markers,
  content_hash,
  canonical_provider_category)
values
(
  '94300000-0000-4000-8000-000000000001',
  'mosera-internal-csprng',
  '1.0.0',
  'CERTIFIED_CSPRNG',
  'Draft',
  false,
  '["UniqueNumberSet","OrderedNumberSequence","UniqueSymbolSet","OrderedSymbolSequence","WeightedSelection","ShufflePermutation","DrawFromUrnDeckBag","CompositeOutcomeGraph","ConstraintValidation"]'::jsonb,
  '{"providerResultHash":true,"providerEvidenceHash":true}'::jsonb,
  '["provider-registration","immutable-configuration","durable-evidence"]'::jsonb,
  'PerDraw',
  '["Requested","Generated","Sealed","Certified"]'::jsonb,
  '{"signatureRequired":true}'::jsonb,
  true,
  'FailClosed',
  '{"generatesOutcomes":true,"ingestsExternalOutcomes":false,"supportsPlayerVerificationReceipt":false,"supportsDeterministicReplay":true,"supportsProviderHealthEvidence":true,"supportsDisputeHandling":true,"supportsExternalSourceEvidence":false,"supportsPhysicalDrawEvidence":false}'::jsonb,
  'sha256:9430000000000000000000000000000000000000000000000000000000000001',
  'INTERNAL_CSPRNG'
),
(
  '94300000-0000-4000-8000-000000000002',
  'mosera-official-results',
  '1.0.0',
  'EXTERNAL_OFFICIAL_RESULT',
  'Draft',
  false,
  '["UniqueNumberSet","OrderedNumberSequence","UniqueSymbolSet","OrderedSymbolSequence","CompositeOutcomeGraph","ConstraintValidation"]'::jsonb,
  '{"providerResultHash":true,"externalSourceEvidence":true}'::jsonb,
  '["provider-registration","immutable-configuration","durable-evidence"]'::jsonb,
  'PerExternalResult',
  '["Requested","Ingested","Sealed","Certified","Disputed"]'::jsonb,
  '{"signatureRequired":true}'::jsonb,
  true,
  'FailClosed',
  '{"generatesOutcomes":false,"ingestsExternalOutcomes":true,"supportsPlayerVerificationReceipt":false,"supportsDeterministicReplay":true,"supportsProviderHealthEvidence":true,"supportsDisputeHandling":true,"supportsExternalSourceEvidence":true,"supportsPhysicalDrawEvidence":false}'::jsonb,
  'sha256:9430000000000000000000000000000000000000000000000000000000000002',
  'OFFICIAL_RESULTS'
),
(
  '94300000-0000-4000-8000-000000000003',
  'mosera-manual-certified',
  '1.0.0',
  'EXTERNAL_OFFICIAL_RESULT',
  'Draft',
  false,
  '["UniqueNumberSet","OrderedNumberSequence","UniqueSymbolSet","OrderedSymbolSequence","CompositeOutcomeGraph","ConstraintValidation"]'::jsonb,
  '{"providerResultHash":true,"operatorCertificationEvidence":true}'::jsonb,
  '["provider-registration","immutable-configuration","durable-evidence"]'::jsonb,
  'PerExternalResult',
  '["Requested","Ingested","Sealed","Certified","Disputed"]'::jsonb,
  '{"signatureRequired":true,"dualApprovalRequired":true}'::jsonb,
  true,
  'FailClosed',
  '{"generatesOutcomes":false,"ingestsExternalOutcomes":true,"supportsPlayerVerificationReceipt":false,"supportsDeterministicReplay":true,"supportsProviderHealthEvidence":true,"supportsDisputeHandling":true,"supportsExternalSourceEvidence":true,"supportsPhysicalDrawEvidence":false}'::jsonb,
  'sha256:9430000000000000000000000000000000000000000000000000000000000003',
  'MANUAL_CERTIFIED'
)
on conflict (provider_id, provider_version) do nothing;

insert into game_engine.outcome_provider_definitions (
  id,
  provider_id,
  provider_version,
  provider_type,
  lifecycle_state,
  production_eligible,
  supported_outcome_primitive_types,
  evidence_requirements,
  health_readiness_capabilities,
  idempotency_model,
  custody_support,
  signing_requirements,
  replayability_support,
  failure_mode,
  capability_markers,
  content_hash,
  canonical_provider_category)
select distinct on (
  manifest.outcome_provider_id,
  manifest.outcome_provider_version)
  gen_random_uuid(),
  manifest.outcome_provider_id,
  manifest.outcome_provider_version,
  case
    when authority.provider_type in ('InternalProductionPrng', 'InternalTestPrng')
      then 'CERTIFIED_CSPRNG'
    else 'EXTERNAL_OFFICIAL_RESULT'
  end,
  'Draft',
  false,
  '["UniqueNumberSet","OrderedNumberSequence","UniqueSymbolSet","OrderedSymbolSequence","WeightedSelection","ShufflePermutation","DrawFromUrnDeckBag","CompositeOutcomeGraph","ConstraintValidation"]'::jsonb,
  '{"providerResultHash":true,"providerEvidenceHash":true}'::jsonb,
  '["legacy-registration","immutable-configuration","durable-evidence"]'::jsonb,
  case
    when authority.provider_type in ('InternalProductionPrng', 'InternalTestPrng')
      then 'PerDraw'
    else 'PerExternalResult'
  end,
  case
    when authority.provider_type in ('InternalProductionPrng', 'InternalTestPrng')
      then '["Requested","Generated","Sealed","Certified"]'::jsonb
    else '["Requested","Ingested","Sealed","Certified","Disputed"]'::jsonb
  end,
  '{"signatureRequired":true}'::jsonb,
  true,
  'FailClosed',
  case
    when authority.provider_type in ('InternalProductionPrng', 'InternalTestPrng')
      then '{"generatesOutcomes":true,"ingestsExternalOutcomes":false,"supportsPlayerVerificationReceipt":false,"supportsDeterministicReplay":true,"supportsProviderHealthEvidence":true,"supportsDisputeHandling":true,"supportsExternalSourceEvidence":false,"supportsPhysicalDrawEvidence":false}'::jsonb
    else '{"generatesOutcomes":false,"ingestsExternalOutcomes":true,"supportsPlayerVerificationReceipt":false,"supportsDeterministicReplay":true,"supportsProviderHealthEvidence":true,"supportsDisputeHandling":true,"supportsExternalSourceEvidence":true,"supportsPhysicalDrawEvidence":false}'::jsonb
  end,
  'sha256:' || encode(digest(
    'canonical-provider:v1|' || manifest.outcome_provider_id || '|' ||
    manifest.outcome_provider_version,
    'sha256'), 'hex'),
  case
    when authority.provider_type in ('InternalProductionPrng', 'InternalTestPrng')
      then 'INTERNAL_CSPRNG'
    when authority.provider_type in ('OfficialFeed', 'ExternalRngProvider', 'SupplierApi')
      then 'OFFICIAL_RESULTS'
    else 'MANUAL_CERTIFIED'
  end
from game_engine.draw_execution_manifests manifest
join game_engine.draw_schedules draw on draw.id = manifest.draw_id
join game_engine.draw_authority_assignments assignment
  on assignment.id = draw.draw_authority_assignment_id
join game_engine.draw_authorities authority
  on authority.id = assignment.draw_authority_id
where not exists (
  select 1
  from game_engine.outcome_provider_definitions provider
  where provider.provider_id = manifest.outcome_provider_id
    and provider.provider_version = manifest.outcome_provider_version
)
order by
  manifest.outcome_provider_id,
  manifest.outcome_provider_version,
  manifest.execution_manifest_id;

alter table game_engine.outcome_provider_definitions
  disable trigger trg_prevent_outcome_provider_update;

update game_engine.outcome_provider_definitions provider
set canonical_provider_category = source.category
from (
  select distinct
    manifest.outcome_provider_id,
    manifest.outcome_provider_version,
    case
      when authority.provider_type in ('InternalProductionPrng', 'InternalTestPrng')
        then 'INTERNAL_CSPRNG'
      when authority.provider_type in ('OfficialFeed', 'ExternalRngProvider', 'SupplierApi')
        then 'OFFICIAL_RESULTS'
      else 'MANUAL_CERTIFIED'
    end as category
  from game_engine.draw_execution_manifests manifest
  join game_engine.draw_schedules draw on draw.id = manifest.draw_id
  join game_engine.draw_authority_assignments assignment
    on assignment.id = draw.draw_authority_assignment_id
  join game_engine.draw_authorities authority
    on authority.id = assignment.draw_authority_id
) source
where provider.provider_id = source.outcome_provider_id
  and provider.provider_version = source.outcome_provider_version
  and provider.canonical_provider_category is null;

alter table game_engine.outcome_provider_definitions
  enable trigger trg_prevent_outcome_provider_update;

create table game_engine.outcome_provider_configuration_versions (
  provider_id text not null,
  provider_version text not null,
  configuration_version text not null,
  canonical_provider_category text not null,
  configuration_hash text not null check (configuration_hash like 'sha256:%'),
  supported_capabilities jsonb not null default '[]'::jsonb
    check (jsonb_typeof(supported_capabilities) = 'array'),
  evidence_requirements jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence_requirements) = 'object'),
  readiness_capabilities jsonb not null default '[]'::jsonb
    check (jsonb_typeof(readiness_capabilities) = 'array'),
  production_ready boolean not null default false,
  failure_mode text not null check (failure_mode = 'FAIL_CLOSED'),
  created_at timestamptz not null default now(),
  primary key (provider_id, provider_version, configuration_version),
  constraint fk_outcome_provider_configuration_definition
    foreign key (provider_id, provider_version)
    references game_engine.outcome_provider_definitions(provider_id, provider_version)
    on delete restrict,
  constraint ck_outcome_provider_configuration_category
    check (canonical_provider_category in (
      'INTERNAL_CSPRNG',
      'OFFICIAL_RESULTS',
      'MANUAL_CERTIFIED'
    ))
);

create table game_engine.outcome_provider_activation_events (
  activation_event_id uuid primary key,
  provider_id text not null,
  provider_version text not null,
  configuration_version text not null,
  activation_state text not null
    check (activation_state in ('DISABLED', 'ENABLED', 'SUSPENDED')),
  reason text not null,
  evidence_hash text not null check (evidence_hash like 'sha256:%'),
  effective_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint fk_outcome_provider_activation_configuration
    foreign key (provider_id, provider_version, configuration_version)
    references game_engine.outcome_provider_configuration_versions(
      provider_id,
      provider_version,
      configuration_version)
    on delete restrict
);

create index idx_outcome_provider_activation_effective
  on game_engine.outcome_provider_activation_events(
    provider_id,
    provider_version,
    configuration_version,
    effective_at desc,
    created_at desc);

insert into game_engine.outcome_provider_configuration_versions (
  provider_id,
  provider_version,
  configuration_version,
  canonical_provider_category,
  configuration_hash,
  supported_capabilities,
  evidence_requirements,
  readiness_capabilities,
  production_ready,
  failure_mode)
select
  provider.provider_id,
  provider.provider_version,
  '1',
  provider.canonical_provider_category,
  'sha256:' || encode(digest(
    'provider-configuration:v1|' || provider.provider_id || '|' ||
    provider.provider_version || '|1',
    'sha256'), 'hex'),
  provider.supported_outcome_primitive_types,
  provider.evidence_requirements,
  provider.health_readiness_capabilities,
  false,
  'FAIL_CLOSED'
from game_engine.outcome_provider_definitions provider
where provider.canonical_provider_category is not null
on conflict (provider_id, provider_version, configuration_version) do nothing;

insert into game_engine.outcome_provider_activation_events (
  activation_event_id,
  provider_id,
  provider_version,
  configuration_version,
  activation_state,
  reason,
  evidence_hash,
  effective_at)
select
  gen_random_uuid(),
  configuration.provider_id,
  configuration.provider_version,
  configuration.configuration_version,
  'DISABLED',
  'BF-4.3 registration only; provider-specific production work is incomplete.',
  'sha256:' || encode(digest(
    'provider-disabled:v1|' || configuration.provider_id || '|' ||
    configuration.provider_version || '|' || configuration.configuration_version,
    'sha256'), 'hex'),
  now()
from game_engine.outcome_provider_configuration_versions configuration;

alter table game_engine.draw_execution_manifests
  add column provider_configuration_version text;

alter table game_engine.draw_execution_manifests
  disable trigger trg_prevent_draw_execution_manifest_update;

update game_engine.draw_execution_manifests
set provider_configuration_version = '1';

alter table game_engine.draw_execution_manifests
  enable trigger trg_prevent_draw_execution_manifest_update;

alter table game_engine.draw_execution_manifests
  alter column provider_configuration_version set not null,
  add constraint fk_draw_execution_manifest_provider_definition
    foreign key (outcome_provider_id, outcome_provider_version)
    references game_engine.outcome_provider_definitions(provider_id, provider_version)
    on delete restrict,
  add constraint fk_draw_execution_manifest_provider_configuration
    foreign key (
      outcome_provider_id,
      outcome_provider_version,
      provider_configuration_version)
    references game_engine.outcome_provider_configuration_versions(
      provider_id,
      provider_version,
      configuration_version)
    on delete restrict;

create table game_engine.outcome_provider_executions (
  execution_id uuid primary key,
  execution_manifest_id uuid not null unique,
  provider_id text not null,
  provider_version text not null,
  configuration_version text not null,
  idempotency_key text not null unique,
  canonical_request_hash text not null check (canonical_request_hash like 'sha256:%'),
  claimed_at timestamptz not null,
  constraint fk_outcome_provider_execution_manifest
    foreign key (execution_manifest_id)
    references game_engine.draw_execution_manifests(execution_manifest_id)
    on delete restrict,
  constraint fk_outcome_provider_execution_configuration
    foreign key (provider_id, provider_version, configuration_version)
    references game_engine.outcome_provider_configuration_versions(
      provider_id,
      provider_version,
      configuration_version)
    on delete restrict
);

create table game_engine.outcome_provider_execution_attempts (
  attempt_id uuid primary key,
  execution_id uuid not null,
  attempt_number integer not null check (attempt_number > 0),
  status text not null check (status in (
    'CLAIMED',
    'RETRYABLE_FAILURE',
    'NON_RETRYABLE_FAILURE',
    'COMPLETED'
  )),
  failure_classification text check (failure_classification in (
    'NONE',
    'RETRYABLE',
    'NON_RETRYABLE'
  )),
  failure_code text,
  failure_reason text,
  request_hash text not null check (request_hash like 'sha256:%'),
  attempt_hash text not null unique check (attempt_hash like 'sha256:%'),
  started_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint ux_outcome_provider_execution_attempt unique (execution_id, attempt_number),
  constraint fk_outcome_provider_attempt_execution
    foreign key (execution_id)
    references game_engine.outcome_provider_executions(execution_id)
    on delete restrict
);

create table game_engine.outcome_provider_execution_evidence (
  evidence_id uuid primary key,
  execution_id uuid not null unique,
  execution_manifest_id uuid not null unique,
  draw_id uuid not null,
  provider_id text not null,
  provider_version text not null,
  configuration_version text not null,
  request_hash text not null check (request_hash like 'sha256:%'),
  result_hash text not null check (result_hash like 'sha256:%'),
  evidence_hash text not null unique check (evidence_hash like 'sha256:%'),
  outcome_certificate_id uuid not null,
  outcome_certificate_hash text not null check (outcome_certificate_hash like 'sha256:%'),
  execution_attempt integer not null check (execution_attempt > 0),
  idempotency_key text not null,
  status text not null check (status = 'AUTHORITATIVE'),
  started_at timestamptz not null,
  completed_at timestamptz not null check (completed_at >= started_at),
  created_at timestamptz not null default now(),
  constraint fk_outcome_provider_evidence_execution
    foreign key (execution_id)
    references game_engine.outcome_provider_executions(execution_id)
    on delete restrict,
  constraint fk_outcome_provider_evidence_manifest
    foreign key (execution_manifest_id)
    references game_engine.draw_execution_manifests(execution_manifest_id)
    on delete restrict,
  constraint fk_outcome_provider_evidence_draw
    foreign key (draw_id)
    references game_engine.draw_schedules(id)
    on delete restrict,
  constraint fk_outcome_provider_evidence_configuration
    foreign key (provider_id, provider_version, configuration_version)
    references game_engine.outcome_provider_configuration_versions(
      provider_id,
      provider_version,
      configuration_version)
    on delete restrict,
  constraint fk_outcome_provider_evidence_certificate
    foreign key (outcome_certificate_id)
    references game_engine.outcome_certificates(certificate_id)
    on delete restrict
);

create index idx_outcome_provider_execution_recovery
  on game_engine.outcome_provider_executions(claimed_at, execution_id);

create index idx_outcome_provider_attempt_status
  on game_engine.outcome_provider_execution_attempts(execution_id, status, attempt_number desc);

create or replace function game_engine.validate_outcome_provider_execution_attempt()
returns trigger
language plpgsql
as $$
declare
  execution record;
begin
  select * into execution
  from game_engine.outcome_provider_executions
  where execution_id = new.execution_id;

  if not found or execution.canonical_request_hash <> new.request_hash then
    raise exception 'Outcome Provider attempt does not match its durable execution claim';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_outcome_provider_execution_evidence()
returns trigger
language plpgsql
as $$
declare
  execution record;
  manifest record;
  certificate record;
begin
  select * into execution
  from game_engine.outcome_provider_executions
  where execution_id = new.execution_id;

  select * into manifest
  from game_engine.draw_execution_manifests
  where execution_manifest_id = new.execution_manifest_id;

  select * into certificate
  from game_engine.outcome_certificates
  where certificate_id = new.outcome_certificate_id;

  if execution.execution_manifest_id <> new.execution_manifest_id
    or execution.provider_id <> new.provider_id
    or execution.provider_version <> new.provider_version
    or execution.configuration_version <> new.configuration_version
    or execution.idempotency_key <> new.idempotency_key
    or execution.canonical_request_hash <> new.request_hash then
    raise exception 'Outcome Provider evidence does not match its durable execution claim';
  end if;

  if manifest.draw_id <> new.draw_id
    or manifest.outcome_provider_id <> new.provider_id
    or manifest.outcome_provider_version <> new.provider_version
    or manifest.provider_configuration_version <> new.configuration_version then
    raise exception 'Outcome Provider evidence does not match its immutable Execution Manifest';
  end if;

  if certificate.draw_id <> new.draw_id
    or certificate.canonical_outcome_hash <> new.outcome_certificate_hash then
    raise exception 'Outcome Provider evidence does not match its Outcome Certificate';
  end if;

  if not exists (
    select 1
    from game_engine.outcome_provider_execution_attempts attempt
    where attempt.execution_id = new.execution_id
      and attempt.attempt_number = new.execution_attempt
      and attempt.status = 'COMPLETED'
  ) then
    raise exception 'Authoritative provider evidence requires a completed execution attempt';
  end if;

  return new;
end;
$$;

create trigger trg_validate_outcome_provider_attempt
before insert on game_engine.outcome_provider_execution_attempts
for each row execute function game_engine.validate_outcome_provider_execution_attempt();

create trigger trg_validate_outcome_provider_evidence
before insert on game_engine.outcome_provider_execution_evidence
for each row execute function game_engine.validate_outcome_provider_execution_evidence();

create trigger trg_prevent_outcome_provider_configuration_update
before update on game_engine.outcome_provider_configuration_versions
for each row execute function game_engine.prevent_immutable_draw_authority_mutation();

create trigger trg_prevent_outcome_provider_configuration_delete
before delete on game_engine.outcome_provider_configuration_versions
for each row execute function game_engine.prevent_immutable_draw_authority_mutation();

create trigger trg_prevent_outcome_provider_activation_update
before update on game_engine.outcome_provider_activation_events
for each row execute function game_engine.prevent_immutable_draw_authority_mutation();

create trigger trg_prevent_outcome_provider_activation_delete
before delete on game_engine.outcome_provider_activation_events
for each row execute function game_engine.prevent_immutable_draw_authority_mutation();

create trigger trg_prevent_outcome_provider_execution_update
before update on game_engine.outcome_provider_executions
for each row execute function game_engine.prevent_immutable_draw_authority_mutation();

create trigger trg_prevent_outcome_provider_execution_delete
before delete on game_engine.outcome_provider_executions
for each row execute function game_engine.prevent_immutable_draw_authority_mutation();

create trigger trg_prevent_outcome_provider_attempt_update
before update on game_engine.outcome_provider_execution_attempts
for each row execute function game_engine.prevent_immutable_draw_authority_mutation();

create trigger trg_prevent_outcome_provider_attempt_delete
before delete on game_engine.outcome_provider_execution_attempts
for each row execute function game_engine.prevent_immutable_draw_authority_mutation();

create trigger trg_prevent_outcome_provider_evidence_update
before update on game_engine.outcome_provider_execution_evidence
for each row execute function game_engine.prevent_immutable_draw_authority_mutation();

create trigger trg_prevent_outcome_provider_evidence_delete
before delete on game_engine.outcome_provider_execution_evidence
for each row execute function game_engine.prevent_immutable_draw_authority_mutation();

comment on column game_engine.outcome_provider_definitions.canonical_provider_category is
  'BF-4.3 canonical category. Null denotes a legacy/test provider outside the production registry.';
comment on table game_engine.outcome_provider_configuration_versions is
  'Immutable configuration versions resolved exclusively through an Execution Manifest.';
comment on table game_engine.outcome_provider_activation_events is
  'Append-only provider activation history. BF-4.3 registers all built-in providers disabled.';
comment on table game_engine.outcome_provider_executions is
  'Durable pre-execution claim. Exactly one provider execution identity exists per immutable Execution Manifest.';
comment on table game_engine.outcome_provider_execution_attempts is
  'Append-only retry and failure evidence for the canonical Outcome Provider Authority.';
comment on table game_engine.outcome_provider_execution_evidence is
  'Exactly one authoritative provider result and evidence binding per Execution Manifest.';
