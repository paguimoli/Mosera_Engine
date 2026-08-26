begin;

alter table game_engine.outcome_events
  add column execution_manifest_id uuid
    references game_engine.draw_execution_manifests(execution_manifest_id) on delete restrict,
  add column provider_evidence_id uuid
    references game_engine.outcome_provider_execution_evidence(evidence_id) on delete restrict;

alter table game_engine.outcome_events
  drop constraint if exists outcome_events_outcome_mode_check,
  add constraint ck_outcome_events_outcome_mode
    check (outcome_mode in ('DryRun', 'Simulation', 'ProductionDisabled', 'CertifiedProvider')),
  add constraint ck_outcome_events_certified_provider_evidence
    check (
      (outcome_mode = 'CertifiedProvider'
        and execution_manifest_id is not null
        and provider_evidence_id is not null)
      or
      (outcome_mode <> 'CertifiedProvider'
        and execution_manifest_id is null
        and provider_evidence_id is null)
    );

create unique index ux_outcome_events_execution_manifest_certified
  on game_engine.outcome_events(execution_manifest_id)
  where outcome_mode = 'CertifiedProvider';

create index idx_outcome_events_provider_evidence
  on game_engine.outcome_events(provider_evidence_id)
  where provider_evidence_id is not null;

create or replace function game_engine.validate_outcome_event()
returns trigger
language plpgsql
as $$
declare
  provider_record record;
  evidence_record record;
  evidence_count integer;
  strategy_count integer;
begin
  if new.outcome_mode = 'ProductionDisabled' then
    raise exception 'Production outcome authority is disabled';
  end if;

  select count(*) into strategy_count
  from game_engine.outcome_strategy_definitions
  where strategy_id = new.strategy_id
    and strategy_version = new.strategy_version;
  if strategy_count = 0 then
    raise exception 'Outcome strategy reference is invalid';
  end if;

  select provider_type, production_eligible into provider_record
  from game_engine.rng_provider_definitions
  where provider_id = new.rng_provider_id
    and provider_version = new.rng_provider_version;
  if not found then
    raise exception 'RNG provider reference is invalid';
  end if;

  if new.outcome_mode = 'CertifiedProvider' then
    if not provider_record.production_eligible then
      raise exception 'Certified provider outcome requires a production-eligible RNG provider';
    end if;

    select evidence.*, manifest.draw_id as manifest_draw_id
      into evidence_record
    from game_engine.outcome_provider_execution_evidence evidence
    join game_engine.draw_execution_manifests manifest
      on manifest.execution_manifest_id = evidence.execution_manifest_id
    where evidence.evidence_id = new.provider_evidence_id
      and evidence.execution_manifest_id = new.execution_manifest_id
      and evidence.status = 'GENERATED';
    if not found
      or evidence_record.draw_id <> new.draw_id
      or evidence_record.manifest_draw_id <> new.draw_id
      or evidence_record.result_hash <> new.canonical_outcome_hash
      or evidence_record.evidence_hash <> new.rng_evidence_hash then
      raise exception 'Certified provider outcome does not match immutable generated provider evidence';
    end if;
    return new;
  end if;

  if provider_record.production_eligible then
    raise exception 'Dry-run outcome generation requires a non-production RNG provider';
  end if;
  if new.outcome_mode = 'DryRun' and provider_record.provider_type <> 'TEST_DETERMINISTIC' then
    raise exception 'Dry-run outcome generation requires a deterministic test RNG provider';
  end if;
  if new.outcome_mode = 'Simulation'
     and provider_record.provider_type not in ('TEST_DETERMINISTIC', 'SIMULATION') then
    raise exception 'Simulation outcome generation requires a deterministic test or simulation RNG provider';
  end if;

  select count(*) into evidence_count
  from game_engine.rng_provider_evidence
  where provider_id = new.rng_provider_id
    and provider_version = new.rng_provider_version
    and canonical_evidence_hash = new.rng_evidence_hash;
  if evidence_count = 0 then
    raise exception 'RNG evidence reference is invalid or missing';
  end if;
  return new;
end;
$$;

alter table game_engine.outcome_settlement_requests
  drop constraint ux_outcome_settlement_requests_version;

create unique index ux_outcome_settlement_requests_version_input
  on game_engine.outcome_settlement_requests(outcome_version_id, settlement_input_id)
  where settlement_input_id is not null;

create unique index ux_outcome_settlement_requests_cancelled_version
  on game_engine.outcome_settlement_requests(outcome_version_id)
  where settlement_input_id is null;

alter table game_engine.canonical_draw_completion_evidence
  drop constraint ux_canonical_draw_completion_version;

create unique index ux_canonical_draw_completion_version_request
  on game_engine.canonical_draw_completion_evidence(outcome_version_id, settlement_request_id);

comment on column game_engine.outcome_events.execution_manifest_id is
  'Exact immutable Execution Manifest certified by scheduler-driven Outcome Certificate closure.';
comment on column game_engine.outcome_events.provider_evidence_id is
  'Exact generated Outcome Provider evidence certified by scheduler-driven Outcome Certificate closure.';
comment on table game_engine.outcome_settlement_requests is
  'Append-only, outbox-backed Settlement request evidence. Published outcomes emit one idempotent request per immutable SettlementInput; cancellations emit one request.';

commit;
