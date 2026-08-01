insert into game_engine.signing_providers (
  id, provider_id, provider_version, provider_type, production_eligible,
  algorithm, key_identifier, algorithm_version, verification_support,
  key_rotation_support, failure_mode, content_hash, lifecycle_state, signature_metadata)
values (
  '94700000-0000-4000-8000-000000000001',
  'mosera-software-signing', '1.0.0', 'SOFTWARE_KEY', true,
  'RSA_SHA256', 'key-v1', '1', true, true, 'FailClosed',
  'sha256:9470000000000000000000000000000000000000000000000000000000000001',
  'Active',
  '{"privateKeyPersisted":false,"publicKeyConfiguredExternally":true}'::jsonb)
on conflict (provider_id, provider_version) do nothing;

create table game_engine.game_engine_production_activation_events (
  activation_event_id uuid primary key,
  provider_id text not null,
  provider_version text not null,
  configuration_version text not null,
  stage text not null check (stage in ('REGISTERED', 'READY', 'APPROVED', 'PRODUCTION_ACTIVE')),
  actor_reference text not null check (btrim(actor_reference) <> ''),
  reason_code text not null check (btrim(reason_code) <> ''),
  approval_reference text not null check (btrim(approval_reference) <> ''),
  signing_provider_id text not null check (btrim(signing_provider_id) <> ''),
  signing_provider_version text not null check (btrim(signing_provider_version) <> ''),
  signing_key_version text not null check (btrim(signing_key_version) <> ''),
  canonical_request_hash text not null check (canonical_request_hash like 'sha256:%'),
  evidence_hash text not null check (evidence_hash like 'sha256:%'),
  idempotency_key text not null unique,
  created_at timestamptz not null,
  constraint fk_game_engine_activation_provider_configuration
    foreign key (provider_id, provider_version, configuration_version)
    references game_engine.outcome_provider_configuration_versions(
      provider_id, provider_version, configuration_version)
    on delete restrict
);

create index idx_game_engine_production_activation_target
  on game_engine.game_engine_production_activation_events(
    provider_id, provider_version, configuration_version, created_at desc, activation_event_id desc);

create index idx_game_engine_production_activation_stage
  on game_engine.game_engine_production_activation_events(stage, created_at desc);

create or replace function game_engine.validate_game_engine_production_activation()
returns trigger
language plpgsql
as $$
declare
  previous_stage text;
  provider_record record;
  signing_record record;
begin
  select event.stage into previous_stage
  from game_engine.game_engine_production_activation_events event
  where event.provider_id = new.provider_id
    and event.provider_version = new.provider_version
    and event.configuration_version = new.configuration_version
  order by event.created_at desc, event.activation_event_id desc
  limit 1;

  if previous_stage is null and new.stage <> 'REGISTERED' then
    raise exception 'Production activation must begin at REGISTERED';
  elsif previous_stage = 'REGISTERED' and new.stage <> 'READY' then
    raise exception 'REGISTERED provider must advance to READY';
  elsif previous_stage = 'READY' and new.stage <> 'APPROVED' then
    raise exception 'READY provider must advance to APPROVED';
  elsif previous_stage = 'APPROVED' and new.stage <> 'PRODUCTION_ACTIVE' then
    raise exception 'APPROVED provider must advance to PRODUCTION_ACTIVE';
  elsif previous_stage = 'PRODUCTION_ACTIVE' then
    raise exception 'Provider is already production active';
  end if;

  if new.stage <> 'REGISTERED' then
    select provider.production_eligible,
      provider.lifecycle_state,
      configuration.production_ready,
      configuration.failure_mode
    into provider_record
    from game_engine.outcome_provider_definitions provider
    join game_engine.outcome_provider_configuration_versions configuration
      on configuration.provider_id = provider.provider_id
     and configuration.provider_version = provider.provider_version
    where provider.provider_id = new.provider_id
      and provider.provider_version = new.provider_version
      and configuration.configuration_version = new.configuration_version;

    if not found
      or not provider_record.production_eligible
      or provider_record.lifecycle_state <> 'Active'
      or not provider_record.production_ready
      or provider_record.failure_mode <> 'FAIL_CLOSED' then
      raise exception 'Production activation requires an active, eligible, production-ready fail-closed provider';
    end if;

    select * into signing_record
    from game_engine.signing_providers signing
    where signing.provider_id = new.signing_provider_id
      and signing.provider_version = new.signing_provider_version;
    if not found
      or signing_record.provider_type <> 'SOFTWARE_KEY'
      or not signing_record.production_eligible
      or signing_record.lifecycle_state <> 'Active'
      or signing_record.algorithm <> 'RSA_SHA256'
      or signing_record.key_identifier <> new.signing_key_version
      or not signing_record.verification_support
      or not signing_record.key_rotation_support
      or signing_record.failure_mode <> 'FailClosed' then
      raise exception 'Production activation requires the exact ready RSA software signing provider and key version';
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_validate_game_engine_production_activation
before insert on game_engine.game_engine_production_activation_events
for each row execute function game_engine.validate_game_engine_production_activation();

create trigger trg_prevent_game_engine_production_activation_update
before update on game_engine.game_engine_production_activation_events
for each row execute function game_engine.prevent_immutable_draw_authority_mutation();

create trigger trg_prevent_game_engine_production_activation_delete
before delete on game_engine.game_engine_production_activation_events
for each row execute function game_engine.prevent_immutable_draw_authority_mutation();

insert into game_engine.game_engine_production_activation_events (
  activation_event_id, provider_id, provider_version, configuration_version,
  stage, actor_reference, reason_code, approval_reference,
  signing_provider_id, signing_provider_version, signing_key_version,
  canonical_request_hash, evidence_hash, idempotency_key, created_at)
select
  gen_random_uuid(), provider.provider_id, provider.provider_version,
  configuration.configuration_version, 'REGISTERED',
  'system:migration-100', 'IMMUTABLE_PROVIDER_REGISTRATION', 'not-applicable',
  'UNASSIGNED', 'UNASSIGNED', 'UNASSIGNED',
  'sha256:' || encode(digest(
    'production-registration|' || provider.provider_id || '|' || provider.provider_version || '|' ||
    configuration.configuration_version, 'sha256'), 'hex'),
  'sha256:' || encode(digest(
    'production-registration-evidence|' || provider.content_hash || '|' || configuration.configuration_hash,
    'sha256'), 'hex'),
  'production-registration:' || provider.provider_id || ':' || provider.provider_version || ':' ||
    configuration.configuration_version,
  now()
from game_engine.outcome_provider_definitions provider
join game_engine.outcome_provider_configuration_versions configuration
  on configuration.provider_id = provider.provider_id
 and configuration.provider_version = provider.provider_version
where provider.canonical_provider_category is not null
  and provider.lifecycle_state = 'Active'
  and provider.production_eligible
  and configuration.production_ready;

create or replace function game_engine.reject_legacy_provider_enablement()
returns trigger
language plpgsql
as $$
begin
  if new.activation_state = 'ENABLED' then
    raise exception 'Legacy Outcome Provider enablement is retired; use Game Engine Production Activation Authority';
  end if;
  return new;
end;
$$;

create trigger trg_reject_legacy_provider_enablement
before insert on game_engine.outcome_provider_activation_events
for each row execute function game_engine.reject_legacy_provider_enablement();

alter table game_engine.certificate_signatures
  drop constraint certificate_signatures_signing_context_check,
  add constraint certificate_signatures_signing_context_check
    check (signing_context in ('DryRun', 'Simulation', 'ProductionDisabled', 'Production')),
  drop constraint certificate_signatures_signature_value_check,
  add constraint certificate_signatures_signature_value_check
    check (btrim(signature_value) <> '');

create or replace function game_engine.validate_production_certificate_signature()
returns trigger
language plpgsql
as $$
declare
  provider record;
begin
  if new.signing_context <> 'Production' then
    return new;
  end if;

  select * into provider
  from game_engine.signing_providers
  where provider_id = new.provider_id and provider_version = new.provider_version;
  if not found
    or provider.provider_type <> 'SOFTWARE_KEY'
    or not provider.production_eligible
    or provider.lifecycle_state <> 'Active'
    or provider.algorithm <> 'RSA_SHA256'
    or not provider.verification_support
    or not provider.key_rotation_support
    or provider.failure_mode <> 'FailClosed'
    or new.verification_status <> 'Verified' then
    raise exception 'Production certificate signature requires a verified production-ready RSA software signing provider';
  end if;
  return new;
end;
$$;

create trigger trg_validate_production_certificate_signature
before insert on game_engine.certificate_signatures
for each row execute function game_engine.validate_production_certificate_signature();

comment on table game_engine.game_engine_production_activation_events is
  'Append-only authoritative Registered, Ready, Approved, and ProductionActive evidence. No provider may activate outside Game Engine Production Activation Authority.';
comment on table game_engine.outcome_provider_activation_events is
  'Historical pre-BF-4.9 provider state evidence. ENABLED insertion is retired and this table is no longer authoritative for production activation.';
comment on table game_engine.certificate_signatures is
  'Append-only certificate signatures. Production context requires verified RSA software-key evidence; private key custody remains external to the database.';
