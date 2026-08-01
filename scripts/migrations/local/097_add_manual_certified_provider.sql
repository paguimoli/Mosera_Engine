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
  '94600000-0000-4000-8000-000000000001',
  'mosera-manual-certified',
  '2.0.0',
  'EXTERNAL_OFFICIAL_RESULT',
  'Active',
  true,
  '["UniqueNumberSet","OrderedNumberSequence","CompositeOutcomeGraph","ConstraintValidation"]'::jsonb,
  '{"officialDrawIdentifier":true,"operatorIdentityReference":true,"certificationReference":true,"reasonCode":true,"submissionTimestamp":true,"normalizedPayload":true,"payloadHash":true,"evidenceHash":true,"replayIdentifier":true,"idempotencyIdentifier":true}'::jsonb,
  '["immutable-submission-contract","exact-draw-matching","game-definition-validation","operator-evidence","certification-evidence","durable-idempotency","supersession","deterministic-replay","recovery","canonical-evidence-persistence"]'::jsonb,
  'PerExternalResult',
  '["Requested","Ingested","Sealed","Certified","Disputed","Superseded"]'::jsonb,
  '{"certificationReferenceRequired":true,"operatorIdentityReferenceRequired":true,"outcomeCertificateRequiredBeforePublication":true}'::jsonb,
  true,
  'FailClosed',
  '{"generatesOutcomes":false,"ingestsExternalOutcomes":true,"supportsPlayerVerificationReceipt":false,"supportsDeterministicReplay":true,"supportsProviderHealthEvidence":true,"supportsDisputeHandling":true,"supportsExternalSourceEvidence":true,"supportsPhysicalDrawEvidence":false}'::jsonb,
  'sha256:9460000000000000000000000000000000000000000000000000000000000001',
  'MANUAL_CERTIFIED'
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
  'mosera-manual-certified',
  '2.0.0',
  '1',
  'MANUAL_CERTIFIED',
  'sha256:9460000000000000000000000000000000000000000000000000000000000002',
  '["ManualCertifiedSubmission","UniqueNumberSet","OrderedNumberSequence","BonusNumberSet","ConstraintValidation"]'::jsonb,
  '{"operatorIdentityReference":true,"certificationReference":true,"reasonCode":true,"submissionTimestamp":true,"normalizedPayload":true,"payloadHash":true,"evidenceHash":true,"replayIdentifier":true,"idempotencyIdentifier":true}'::jsonb,
  '["immutable-submission","exact-draw-matching","immutable-game-definition-validation","durable-idempotency","supersession-chain","replay-validation","recovery","canonical-publication-binding"]'::jsonb,
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
  '94600000-0000-4000-8000-000000000003',
  'mosera-manual-certified',
  '2.0.0',
  '1',
  'DISABLED',
  'BF-4.6 provider is production-ready but requires separate governed activation.',
  'sha256:9460000000000000000000000000000000000000000000000000000000000003',
  now()
);

create or replace function game_engine.validate_manual_certified_provider_evidence()
returns trigger
language plpgsql
as $$
declare
  payload jsonb;
  normalized jsonb;
begin
  if new.provider_id <> 'mosera-manual-certified'
    or new.provider_version <> '2.0.0' then
    return new;
  end if;

  payload := new.provider_evidence_payload;
  normalized := payload -> 'normalizedResult';
  if jsonb_typeof(payload) <> 'object'
    or coalesce(payload ->> 'operatorIdentityReference', '') = ''
    or coalesce(payload ->> 'certificationReference', '') = ''
    or coalesce(payload ->> 'reasonCode', '') = ''
    or jsonb_typeof(payload -> 'submissionTimestamp') <> 'string'
    or coalesce(payload ->> 'submissionEvidenceHash', '') not like 'sha256:%'
    or coalesce(payload ->> 'normalizedPayloadHash', '') not like 'sha256:%'
    or coalesce(payload ->> 'evidenceHash', '') not like 'sha256:%'
    or coalesce(payload ->> 'replayIdentifier', '') = ''
    or coalesce(payload ->> 'canonicalRequestHash', '') not like 'sha256:%'
    or jsonb_typeof(normalized) <> 'object'
    or coalesce(normalized ->> 'officialDrawIdentifier', '') = ''
    or jsonb_typeof(normalized -> 'certifiedNumbers') <> 'array'
    or jsonb_typeof(normalized -> 'bonusNumbers') <> 'array'
    or coalesce(normalized ->> 'canonicalPayloadHash', '') <> new.result_hash then
    raise exception 'Manual Certified provider evidence is incomplete or inconsistent';
  end if;

  return new;
end;
$$;

create trigger trg_validate_manual_certified_provider_evidence
before insert on game_engine.outcome_provider_execution_evidence
for each row execute function game_engine.validate_manual_certified_provider_evidence();

comment on function game_engine.validate_manual_certified_provider_evidence() is
  'BF-4.6 fail-closed validation for immutable Manual Certified provider evidence in the canonical Outcome Provider Authority.';
