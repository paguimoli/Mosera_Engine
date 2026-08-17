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
  provider_id,
  provider_version,
  '2',
  canonical_provider_category,
  'sha256:' || encode(digest(
    provider_id || '|' || provider_version || '|2|csprng-1.3b-evidence-minimization',
    'sha256'), 'hex'),
  supported_capabilities,
  (evidence_requirements - 'seedIdentifier') ||
    '{"executionProvenanceIdentifier":true,"generateRequestMaximumBytes":65536,"reseedIntervalMaximum":281474976710656}'::jsonb,
  readiness_capabilities,
  production_ready,
  failure_mode
from game_engine.outcome_provider_configuration_versions
where provider_id = 'mosera-internal-csprng'
  and provider_version = '2.0.0'
  and configuration_version = '1'
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
  '11900000-0000-4000-8000-000000000001',
  provider_id,
  provider_version,
  configuration_version,
  'DISABLED',
  'CSPRNG-1.3B remediated configuration requires separate governed activation.',
  'sha256:' || encode(digest(
    provider_id || '|' || provider_version || '|' || configuration_version ||
      '|DISABLED|csprng-1.3b',
    'sha256'), 'hex'),
  now()
from game_engine.outcome_provider_configuration_versions
where provider_id = 'mosera-internal-csprng'
  and provider_version = '2.0.0'
  and configuration_version = '2'
  and not exists (
    select 1
    from game_engine.outcome_provider_activation_events activation
    where activation.activation_event_id = '11900000-0000-4000-8000-000000000001'
  );

comment on column game_engine.outcome_provider_configuration_versions.evidence_requirements is
  'Versioned evidence contract. CSPRNG configuration 2 replaces secret-derived seed identifiers with non-secret execution provenance and records the enforced SP 800-90A runtime envelope.';
