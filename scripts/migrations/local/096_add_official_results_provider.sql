alter table game_engine.outcome_provider_executions
  drop constraint if exists outcome_provider_executions_execution_manifest_id_key,
  add column execution_version integer not null default 1,
  add column supersedes_execution_id uuid;

alter table game_engine.outcome_provider_executions
  add constraint ck_outcome_provider_execution_version
    check (execution_version > 0),
  add constraint fk_outcome_provider_execution_supersedes
    foreign key (supersedes_execution_id)
    references game_engine.outcome_provider_executions(execution_id)
    on delete restrict,
  add constraint ux_outcome_provider_execution_manifest_version
    unique (execution_manifest_id, execution_version),
  add constraint ux_outcome_provider_execution_supersedes
    unique (supersedes_execution_id);

create or replace function game_engine.validate_outcome_provider_execution_chain()
returns trigger
language plpgsql
as $$
declare
  previous record;
begin
  if new.execution_version = 1 then
    if new.supersedes_execution_id is not null then
      raise exception 'Initial Outcome Provider execution cannot supersede another execution';
    end if;
    return new;
  end if;

  if new.supersedes_execution_id is null then
    raise exception 'Versioned Outcome Provider execution requires a superseded execution';
  end if;

  select * into previous
  from game_engine.outcome_provider_executions
  where execution_id = new.supersedes_execution_id;

  if not found
    or previous.execution_manifest_id <> new.execution_manifest_id
    or previous.provider_id <> new.provider_id
    or previous.provider_version <> new.provider_version
    or previous.configuration_version <> new.configuration_version
    or previous.execution_version + 1 <> new.execution_version then
    raise exception 'Outcome Provider supersession chain is inconsistent';
  end if;

  if not exists (
    select 1
    from game_engine.outcome_provider_execution_evidence evidence
    where evidence.execution_id = previous.execution_id
      and evidence.status = 'GENERATED'
  ) then
    raise exception 'Outcome Provider supersession requires completed prior evidence';
  end if;

  return new;
end;
$$;

create trigger trg_validate_outcome_provider_execution_chain
before insert on game_engine.outcome_provider_executions
for each row execute function game_engine.validate_outcome_provider_execution_chain();

drop index if exists game_engine.ux_outcome_provider_authoritative_manifest;

create index idx_outcome_provider_execution_manifest_version
  on game_engine.outcome_provider_executions(
    execution_manifest_id,
    execution_version desc);

create or replace function game_engine.validate_number_outcome_generation_definition()
returns trigger
language plpgsql
as $$
declare
  definition jsonb;
  bonus jsonb;
  universe_count integer;
  distinct_count integer;
  numbers_required integer;
  unique_numbers boolean;
  with_replacement boolean;
begin
  definition := new.outcome_generation_definition;
  if definition is null then
    return new;
  end if;

  if jsonb_typeof(definition) <> 'object'
    or jsonb_typeof(definition -> 'NumberUniverse') <> 'array'
    or jsonb_typeof(definition -> 'NumbersRequired') <> 'number'
    or jsonb_typeof(definition -> 'Unique') <> 'boolean'
    or jsonb_typeof(definition -> 'WithReplacement') <> 'boolean'
    or definition ->> 'Ordering' not in ('DrawOrder', 'Ascending') then
    raise exception 'Game Definition outcome generation definition is invalid';
  end if;

  select count(*), count(distinct value)
    into universe_count, distinct_count
  from jsonb_array_elements_text(definition -> 'NumberUniverse') number(value);

  numbers_required := (definition ->> 'NumbersRequired')::integer;
  unique_numbers := (definition ->> 'Unique')::boolean;
  with_replacement := (definition ->> 'WithReplacement')::boolean;

  if universe_count = 0 or universe_count <> distinct_count then
    raise exception 'Game Definition number universe must contain distinct values';
  end if;
  if numbers_required <= 0 then
    raise exception 'Game Definition numbers required must be positive';
  end if;
  if unique_numbers and with_replacement then
    raise exception 'Unique Game Definition generation cannot use replacement';
  end if;
  if not with_replacement and numbers_required > universe_count then
    raise exception 'Game Definition requests too many numbers without replacement';
  end if;

  bonus := definition -> 'BonusNumbers';
  if bonus is null or bonus = 'null'::jsonb then
    return new;
  end if;

  if jsonb_typeof(bonus) <> 'object'
    or jsonb_typeof(bonus -> 'NumberUniverse') <> 'array'
    or jsonb_typeof(bonus -> 'NumbersRequired') <> 'number'
    or jsonb_typeof(bonus -> 'Unique') <> 'boolean'
    or jsonb_typeof(bonus -> 'WithReplacement') <> 'boolean'
    or jsonb_typeof(bonus -> 'MayOverlapPrimary') <> 'boolean'
    or bonus ->> 'Ordering' not in ('DrawOrder', 'Ascending') then
    raise exception 'Game Definition bonus number definition is invalid';
  end if;

  select count(*), count(distinct value)
    into universe_count, distinct_count
  from jsonb_array_elements_text(bonus -> 'NumberUniverse') number(value);
  numbers_required := (bonus ->> 'NumbersRequired')::integer;
  unique_numbers := (bonus ->> 'Unique')::boolean;
  with_replacement := (bonus ->> 'WithReplacement')::boolean;

  if universe_count = 0 or universe_count <> distinct_count
    or numbers_required <= 0
    or (unique_numbers and with_replacement)
    or (not with_replacement and numbers_required > universe_count) then
    raise exception 'Game Definition bonus number rules are inconsistent';
  end if;

  return new;
end;
$$;

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
values (
  '94500000-0000-4000-8000-000000000001',
  'mosera-official-results',
  '2.0.0',
  'EXTERNAL_OFFICIAL_RESULT',
  'Active',
  true,
  '["UniqueNumberSet","OrderedNumberSequence","CompositeOutcomeGraph","ConstraintValidation"]'::jsonb,
  '{"sourceIdentifier":true,"retrievalMethod":true,"retrievalTimestamp":true,"normalizationVersion":true,"validationResult":true,"rawPayloadHash":true,"normalizedPayloadHash":true,"sourceAuthenticationEvidenceHash":true,"transportEvidenceHash":true,"executionIdentifiers":true,"replayIdentifier":true}'::jsonb,
  '["source-registry","acquisition-contract","canonical-normalization","game-definition-validation","exact-draw-matching","durable-idempotency","supersession","deterministic-replay","canonical-evidence-persistence"]'::jsonb,
  'PerExternalResult',
  '["Requested","Ingested","Sealed","Certified","Disputed","Superseded"]'::jsonb,
  '{"sourceAuthenticationEvidenceRequired":true,"outcomeCertificateRequiredBeforePublication":true}'::jsonb,
  true,
  'FailClosed',
  '{"generatesOutcomes":false,"ingestsExternalOutcomes":true,"supportsPlayerVerificationReceipt":false,"supportsDeterministicReplay":true,"supportsProviderHealthEvidence":true,"supportsDisputeHandling":true,"supportsExternalSourceEvidence":true,"supportsPhysicalDrawEvidence":false}'::jsonb,
  'sha256:9450000000000000000000000000000000000000000000000000000000000001',
  'OFFICIAL_RESULTS'
);

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
values (
  'mosera-official-results',
  '2.0.0',
  '1',
  'OFFICIAL_RESULTS',
  'sha256:9450000000000000000000000000000000000000000000000000000000000002',
  '["OfficialApi","OfficialFile","OfficialScraper","ManualImport","UniqueNumberSet","OrderedNumberSequence","BonusNumberSet","ConstraintValidation"]'::jsonb,
  '{"sourceIdentifier":true,"retrievalMethod":true,"retrievalTimestamp":true,"normalizationVersion":true,"validationResult":true,"rawPayloadHash":true,"normalizedPayloadHash":true,"evidenceHash":true,"executionIdentifiers":true,"replayIdentifiers":true}'::jsonb,
  '["source-registry","canonical-normalization","exact-draw-matching","immutable-game-definition-validation","durable-idempotency","supersession-chain","replay-validation","recovery","canonical-publication-binding"]'::jsonb,
  true,
  'FAIL_CLOSED'
);

insert into game_engine.outcome_provider_activation_events (
  activation_event_id,
  provider_id,
  provider_version,
  configuration_version,
  activation_state,
  reason,
  evidence_hash,
  effective_at)
values (
  '94500000-0000-4000-8000-000000000003',
  'mosera-official-results',
  '2.0.0',
  '1',
  'DISABLED',
  'BF-4.5 provider is production-ready but requires separate governed activation.',
  'sha256:9450000000000000000000000000000000000000000000000000000000000003',
  now()
);

comment on table game_engine.external_result_ingestion_events is
  'Historical P0 external-result evidence retained append-only. BF-4.5 production ingestion writes only canonical Outcome Provider execution evidence.';

comment on table game_engine.external_result_verification_evidence is
  'Historical P0 verification evidence retained append-only. No production repository writes this table after BF-4.5.';

comment on column game_engine.outcome_provider_executions.execution_version is
  'Immutable provider execution version. Official result corrections create a new superseding execution under the same Draw Execution Manifest.';
