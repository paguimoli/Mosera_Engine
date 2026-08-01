alter table game_engine.outcome_provider_execution_evidence
  add column canonical_result_payload jsonb,
  add column canonical_result_hash text;

alter table game_engine.outcome_provider_execution_evidence
  add constraint ck_outcome_provider_evidence_canonical_result_pair
    check (
      (canonical_result_payload is null and canonical_result_hash is null)
      or (
        jsonb_typeof(canonical_result_payload) = 'object'
        and canonical_result_hash like 'sha256:%'
      )
    );

alter table game_engine.canonical_outcome_versions
  add column authority_model_version text not null default 'LEGACY_V0',
  add column provider_evidence_id uuid,
  add column provider_execution_id uuid,
  add column outcome_provider_category text,
  add column outcome_provider_id text,
  add column outcome_provider_version text,
  add column provider_configuration_version text,
  add column provider_evidence_hash text,
  add column game_definition_version_id uuid,
  add column game_definition_hash text,
  add column evaluator_version text,
  add column certificate_signature_id uuid,
  add column certificate_verification_hash text,
  add column validated_outcome_payload jsonb,
  add column validated_outcome_hash text,
  add column validated_primary_result jsonb,
  add column validated_bonus_result jsonb,
  add column derived_outcome_data jsonb,
  add column outcome_schema_version text,
  add column actor_reference text,
  add column reason_code text,
  add column lifecycle_evidence_hash text;

alter table game_engine.canonical_outcome_versions
  add constraint ck_canonical_outcome_authority_model
    check (authority_model_version in ('LEGACY_V0', 'CANONICAL_V1')),
  add constraint ck_canonical_outcome_provider_category
    check (
      outcome_provider_category is null
      or outcome_provider_category in ('INTERNAL_CSPRNG', 'OFFICIAL_RESULTS', 'MANUAL_CERTIFIED')
    ),
  add constraint ck_canonical_outcome_v1_complete
    check (
      authority_model_version = 'LEGACY_V0'
      or (
        provider_evidence_id is not null
        and provider_execution_id is not null
        and btrim(outcome_provider_category) <> ''
        and btrim(outcome_provider_id) <> ''
        and btrim(outcome_provider_version) <> ''
        and btrim(provider_configuration_version) <> ''
        and provider_evidence_hash like 'sha256:%'
        and game_definition_version_id is not null
        and game_definition_hash like 'sha256:%'
        and btrim(evaluator_version) <> ''
        and certificate_signature_id is not null
        and certificate_verification_hash like 'sha256:%'
        and jsonb_typeof(validated_outcome_payload) = 'object'
        and validated_outcome_hash like 'sha256:%'
        and jsonb_typeof(validated_primary_result) = 'array'
        and jsonb_typeof(validated_bonus_result) = 'array'
        and jsonb_typeof(derived_outcome_data) = 'object'
        and btrim(outcome_schema_version) <> ''
        and btrim(actor_reference) <> ''
        and btrim(reason_code) <> ''
        and lifecycle_evidence_hash like 'sha256:%'
      )
    ),
  add constraint fk_canonical_outcome_provider_evidence
    foreign key (provider_evidence_id)
    references game_engine.outcome_provider_execution_evidence(evidence_id)
    on delete restrict,
  add constraint fk_canonical_outcome_provider_execution
    foreign key (provider_execution_id)
    references game_engine.outcome_provider_executions(execution_id)
    on delete restrict,
  add constraint fk_canonical_outcome_game_definition_version
    foreign key (game_definition_version_id)
    references game_engine.game_definition_versions(id)
    on delete restrict,
  add constraint fk_canonical_outcome_certificate_signature
    foreign key (certificate_signature_id)
    references game_engine.certificate_signatures(signature_id)
    on delete restrict;

alter table game_engine.canonical_outcome_versions
  drop constraint canonical_outcome_versions_outcome_id_fkey,
  add constraint fk_canonical_outcome_event
    foreign key (outcome_id)
    references game_engine.outcome_events(outcome_id)
    on delete restrict,
  drop constraint canonical_outcome_versions_outcome_certificate_id_fkey,
  add constraint fk_canonical_outcome_certificate
    foreign key (outcome_certificate_id)
    references game_engine.outcome_certificates(certificate_id)
    on delete restrict,
  drop constraint canonical_outcome_versions_previous_outcome_version_id_fkey,
  add constraint fk_canonical_outcome_previous_version
    foreign key (previous_outcome_version_id)
    references game_engine.canonical_outcome_versions(outcome_version_id)
    on delete restrict;

alter table game_engine.outcome_settlement_requests
  drop constraint outcome_settlement_requests_outcome_version_id_fkey,
  add constraint fk_outcome_settlement_canonical_version
    foreign key (outcome_version_id)
    references game_engine.canonical_outcome_versions(outcome_version_id)
    on delete restrict,
  drop constraint outcome_settlement_requests_settlement_input_id_fkey,
  add constraint fk_outcome_settlement_input
    foreign key (settlement_input_id)
    references game_engine.settlement_input_records(settlement_input_id)
    on delete restrict;

create index idx_canonical_outcome_provider_evidence
  on game_engine.canonical_outcome_versions(provider_evidence_id);

create index idx_canonical_outcome_manifest_provider
  on game_engine.canonical_outcome_versions(
    execution_manifest_id,
    outcome_provider_category,
    outcome_provider_id,
    outcome_provider_version,
    provider_configuration_version);

create index idx_canonical_outcome_game_evaluator
  on game_engine.canonical_outcome_versions(game_definition_version_id, evaluator_version);

create index idx_canonical_outcome_validated_hash
  on game_engine.canonical_outcome_versions(validated_outcome_hash);

create or replace function game_engine.validate_canonical_outcome_version()
returns trigger
language plpgsql
as $$
declare
  source_record record;
  manifest_record record;
  provider_record record;
  signature_record record;
  definition_record record;
  current_record record;
  primary_rules jsonb;
  bonus_rules jsonb;
  value_json jsonb;
  previous_certificate_id text;
begin
  if new.authority_model_version <> 'CANONICAL_V1' then
    raise exception 'New canonical outcomes require the CANONICAL_V1 authority model';
  end if;

  select oe.outcome_id, oe.draw_id, oe.outcome_payload, oe.canonical_outcome_hash,
         oe.generated_at, oc.previous_certificates
  into source_record
  from game_engine.outcome_certificates oc
  join game_engine.outcome_events oe on oe.outcome_id = oc.outcome_id
  where oc.certificate_id = new.outcome_certificate_id
    and oc.canonical_outcome_hash = new.outcome_certificate_hash
    and oc.custody_state = 'Certified';
  if not found
    or source_record.outcome_id <> new.outcome_id
    or source_record.draw_id <> new.draw_id
    or source_record.outcome_payload <> new.outcome_payload
    or source_record.canonical_outcome_hash <> new.canonical_outcome_hash
    or source_record.generated_at <> new.generated_at then
    raise exception 'Canonical outcome does not match exact certified Outcome Certificate evidence';
  end if;

  select * into manifest_record
  from game_engine.draw_execution_manifests
  where execution_manifest_id = new.execution_manifest_id;
  if not found
    or manifest_record.draw_id <> new.draw_id
    or manifest_record.canonical_manifest_hash <> new.execution_manifest_hash
    or manifest_record.game_definition_version_id <> new.game_definition_version_id
    or manifest_record.evaluator_version <> new.evaluator_version
    or manifest_record.outcome_provider_id <> new.outcome_provider_id
    or manifest_record.outcome_provider_version <> new.outcome_provider_version
    or manifest_record.provider_configuration_version <> new.provider_configuration_version then
    raise exception 'Canonical outcome does not match its exact Execution Manifest';
  end if;

  select evidence.*, configuration.canonical_provider_category,
         execution.supersedes_execution_id
  into provider_record
  from game_engine.outcome_provider_execution_evidence evidence
  join game_engine.outcome_provider_executions execution
    on execution.execution_id = evidence.execution_id
  join game_engine.outcome_provider_configuration_versions configuration
    on configuration.provider_id = evidence.provider_id
   and configuration.provider_version = evidence.provider_version
   and configuration.configuration_version = evidence.configuration_version
  where evidence.evidence_id = new.provider_evidence_id;
  if not found
    or provider_record.execution_id <> new.provider_execution_id
    or provider_record.execution_manifest_id <> new.execution_manifest_id
    or provider_record.draw_id <> new.draw_id
    or provider_record.status <> 'AUTHORITATIVE'
    or provider_record.outcome_certificate_id <> new.outcome_certificate_id
    or provider_record.outcome_certificate_hash <> new.outcome_certificate_hash
    or provider_record.provider_id <> new.outcome_provider_id
    or provider_record.provider_version <> new.outcome_provider_version
    or provider_record.configuration_version <> new.provider_configuration_version
    or provider_record.canonical_provider_category <> new.outcome_provider_category
    or provider_record.evidence_hash <> new.provider_evidence_hash
    or provider_record.canonical_result_payload <> new.validated_outcome_payload
    or provider_record.canonical_result_hash <> new.validated_outcome_hash then
    raise exception 'Canonical outcome does not match exact authoritative provider evidence';
  end if;

  if new.validated_outcome_payload ->> 'schemaVersion' <> new.outcome_schema_version
    or (new.validated_outcome_payload ->> 'drawId')::uuid <> new.draw_id
    or (new.validated_outcome_payload ->> 'executionManifestId')::uuid <> new.execution_manifest_id
    or (new.validated_outcome_payload ->> 'gameDefinitionVersionId')::uuid <> new.game_definition_version_id
    or new.validated_outcome_payload ->> 'gameDefinitionHash' <> new.game_definition_hash
    or new.validated_outcome_payload ->> 'evaluatorVersion' <> new.evaluator_version
    or new.validated_outcome_payload -> 'primaryNumbers' <> new.validated_primary_result
    or new.validated_outcome_payload -> 'bonusNumbers' <> new.validated_bonus_result
    or new.validated_outcome_payload -> 'derivedOutcomeData' <> new.derived_outcome_data
    or new.validated_outcome_payload ->> 'sourceResultHash' <> new.outcome_certificate_hash then
    raise exception 'Canonical validated result envelope is inconsistent';
  end if;

  select * into definition_record
  from game_engine.game_definition_versions
  where id = new.game_definition_version_id;
  if not found
    or definition_record.definition_hash <> new.game_definition_hash
    or definition_record.evaluator_version <> new.evaluator_version
    or definition_record.outcome_generation_definition is null then
    raise exception 'Canonical outcome requires exact immutable Game Definition rules';
  end if;

  primary_rules := definition_record.outcome_generation_definition;
  if jsonb_array_length(new.validated_primary_result) <> (primary_rules ->> 'NumbersRequired')::integer then
    raise exception 'Canonical primary result count is invalid';
  end if;
  for value_json in select value from jsonb_array_elements(new.validated_primary_result) loop
    if not (primary_rules -> 'NumberUniverse') @> jsonb_build_array(value_json) then
      raise exception 'Canonical primary result is outside the immutable universe';
    end if;
  end loop;
  if coalesce((primary_rules ->> 'Unique')::boolean, false)
     or not coalesce((primary_rules ->> 'WithReplacement')::boolean, false) then
    if (select count(*) from jsonb_array_elements(new.validated_primary_result)) <>
       (select count(distinct value) from jsonb_array_elements(new.validated_primary_result)) then
      raise exception 'Canonical primary result violates uniqueness or replacement rules';
    end if;
  end if;

  bonus_rules := primary_rules -> 'BonusNumbers';
  if bonus_rules is null or bonus_rules = 'null'::jsonb then
    if jsonb_array_length(new.validated_bonus_result) <> 0 then
      raise exception 'Canonical bonus result is not permitted';
    end if;
  else
    if jsonb_array_length(new.validated_bonus_result) <> (bonus_rules ->> 'NumbersRequired')::integer then
      raise exception 'Canonical bonus result count is invalid';
    end if;
    for value_json in select value from jsonb_array_elements(new.validated_bonus_result) loop
      if not (bonus_rules -> 'NumberUniverse') @> jsonb_build_array(value_json) then
        raise exception 'Canonical bonus result is outside the immutable universe';
      end if;
    end loop;
    if not coalesce((bonus_rules ->> 'MayOverlapPrimary')::boolean, false)
       and exists (
         select 1
         from jsonb_array_elements(new.validated_primary_result) primary_value
         join jsonb_array_elements(new.validated_bonus_result) bonus_value
           on primary_value.value = bonus_value.value
       ) then
      raise exception 'Canonical bonus result violates immutable overlap rules';
    end if;
  end if;

  select signature.*, provider.lifecycle_state, provider.verification_support,
         provider.failure_mode
  into signature_record
  from game_engine.certificate_signatures signature
  join game_engine.signing_providers provider
    on provider.provider_id = signature.provider_id
   and provider.provider_version = signature.provider_version
  where signature.signature_id = new.certificate_signature_id;
  if not found
    or signature_record.certificate_reference_type <> 'OutcomeCertificate'
    or signature_record.certificate_id <> new.outcome_certificate_id
    or signature_record.canonical_payload_hash <> new.outcome_certificate_hash
    or signature_record.verification_status <> 'Verified'
    or signature_record.lifecycle_state <> 'Active'
    or not signature_record.verification_support
    or signature_record.failure_mode <> 'FailClosed' then
    raise exception 'Canonical outcome requires exact verified fail-closed certificate evidence';
  end if;

  select outcome_version_id, version_number, version_kind, canonical_outcome_hash,
         provider_evidence_id, provider_execution_id, outcome_certificate_id
  into current_record
  from game_engine.canonical_outcome_versions
  where draw_id = new.draw_id
  order by version_number desc
  limit 1;

  if new.version_kind = 'Published' then
    if found or new.previous_outcome_version_id is not null or new.version_number <> 1 then
      raise exception 'Initial publication must be version one';
    end if;
  else
    if not found
      or new.previous_outcome_version_id is distinct from current_record.outcome_version_id
      or new.version_number <> current_record.version_number + 1 then
      raise exception 'Correction or cancellation must supersede the exact current version';
    end if;
    if current_record.version_kind = 'Cancelled' then
      raise exception 'A cancelled outcome is terminal';
    end if;
    if new.version_kind = 'Corrected' then
      if new.canonical_outcome_hash = current_record.canonical_outcome_hash
        or new.provider_evidence_id = current_record.provider_evidence_id
        or provider_record.supersedes_execution_id is distinct from current_record.provider_execution_id then
        raise exception 'Correction requires different certified evidence that supersedes the prior provider execution';
      end if;
      previous_certificate_id := current_record.outcome_certificate_id::text;
      if not exists (
        select 1
        from jsonb_array_elements(source_record.previous_certificates) reference
        where coalesce(reference ->> 'certificateId', reference ->> 'CertificateId') = previous_certificate_id
      ) then
        raise exception 'Correction Outcome Certificate must reference the superseded certificate';
      end if;
    end if;
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_outcome_settlement_request()
returns trigger
language plpgsql
as $$
declare
  version_record record;
  input_record record;
  current_version_id uuid;
begin
  select * into version_record
  from game_engine.canonical_outcome_versions
  where outcome_version_id = new.outcome_version_id;
  if not found
    or version_record.authority_model_version <> 'CANONICAL_V1'
    or version_record.draw_id <> new.draw_id
    or version_record.version_kind <> new.request_kind then
    raise exception 'Settlement request does not match a canonical V1 outcome version';
  end if;

  select outcome_version_id into current_version_id
  from game_engine.canonical_outcome_versions
  where draw_id = new.draw_id
  order by version_number desc
  limit 1;
  if current_version_id <> new.outcome_version_id then
    raise exception 'Settlement request requires the current canonical outcome version';
  end if;

  if new.request_kind = 'Cancelled' then
    if new.settlement_input_id is not null then
      raise exception 'Cancellation settlement requests cannot carry a SettlementInput';
    end if;
  else
    if new.settlement_input_id is null then
      raise exception 'Published and corrected outcomes require a SettlementInput';
    end if;
    select outcome_certificate_id, outcome_certificate_hash, evaluator_version
    into input_record
    from game_engine.settlement_input_records
    where settlement_input_id = new.settlement_input_id;
    if not found
      or input_record.outcome_certificate_id <> version_record.outcome_certificate_id
      or input_record.outcome_certificate_hash <> version_record.outcome_certificate_hash
      or input_record.evaluator_version <> version_record.evaluator_version then
      raise exception 'SettlementInput does not bind the exact certificate and evaluator of the canonical outcome';
    end if;
  end if;
  return new;
end;
$$;

comment on column game_engine.outcome_provider_execution_evidence.canonical_result_payload is
  'Provider-neutral validated result envelope consumed exclusively by Canonical Outcome Authority.';

comment on column game_engine.canonical_outcome_versions.authority_model_version is
  'LEGACY_V0 marks retained read-only history; every new authoritative publication is CANONICAL_V1.';

comment on table game_engine.canonical_outcome_versions is
  'Single append-only Canonical Outcome Aggregate. It binds exact draw, manifest, provider evidence, game definition, evaluator, verified certificate, lifecycle evidence, outbox publication, and Settlement handoff.';
