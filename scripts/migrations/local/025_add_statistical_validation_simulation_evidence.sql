create table game_engine.statistical_validation_results (
  id uuid primary key,
  validation_type text not null,
  target_artifact_type text not null,
  target_artifact_id text not null,
  target_artifact_version text,
  target_artifact_hash text not null,
  sample_size bigint not null,
  expected_distribution jsonb not null default '{}'::jsonb,
  observed_distribution jsonb not null default '{}'::jsonb,
  p_value numeric(18, 12),
  score numeric(18, 12),
  result_status text not null,
  certification_ready boolean not null default false,
  generated_at timestamptz not null,
  canonical_result_hash text not null,
  signing_metadata jsonb,
  created_at timestamptz not null default now(),
  constraint ux_statistical_validation_results_hash unique (canonical_result_hash),
  check (validation_type in ('FREQUENCY', 'CHI_SQUARE', 'RUNS', 'DISTRIBUTION_DRIFT', 'RTP_SIMULATION', 'PRIZE_DISTRIBUTION')),
  check (target_artifact_type in ('OutcomeStrategy', 'RngProvider', 'MathModel', 'Paytable', 'CertificationPack')),
  check (sample_size > 0),
  check (jsonb_typeof(expected_distribution) = 'object'),
  check (jsonb_typeof(observed_distribution) = 'object'),
  check (p_value is null or (p_value >= 0 and p_value <= 1)),
  check (result_status in ('Pass', 'Fail', 'Inconclusive')),
  check (target_artifact_hash like 'sha256:%'),
  check (canonical_result_hash like 'sha256:%'),
  check (signing_metadata is null or jsonb_typeof(signing_metadata) = 'object')
);

create table game_engine.simulation_evidence (
  id uuid primary key,
  simulation_mode text not null,
  outcome_strategy_id text not null,
  outcome_strategy_version text not null,
  outcome_strategy_hash text not null,
  math_model_id text not null,
  math_model_version text not null,
  math_model_hash text not null,
  paytable_id text not null,
  paytable_version text not null,
  paytable_hash text not null,
  rng_provider_id text not null,
  rng_provider_version text not null,
  rng_provider_hash text not null,
  iteration_count bigint not null,
  theoretical_rtp numeric(12, 8) not null,
  observed_rtp numeric(12, 8) not null,
  variance numeric(18, 8) not null,
  hit_frequency numeric(12, 8) not null,
  prize_distribution jsonb not null default '{}'::jsonb,
  confidence_interval jsonb not null default '{}'::jsonb,
  production_outcome_evidence boolean not null default false,
  canonical_evidence_hash text not null,
  signing_metadata jsonb,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint ux_simulation_evidence_hash unique (canonical_evidence_hash),
  check (simulation_mode in ('DryRun', 'Simulation', 'ProductionDisabled')),
  check (outcome_strategy_hash like 'sha256:%'),
  check (math_model_hash like 'sha256:%'),
  check (paytable_hash like 'sha256:%'),
  check (rng_provider_hash like 'sha256:%'),
  check (iteration_count > 0),
  check (theoretical_rtp > 0 and theoretical_rtp <= 1),
  check (observed_rtp >= 0 and observed_rtp <= 1),
  check (variance >= 0),
  check (hit_frequency >= 0 and hit_frequency <= 1),
  check (jsonb_typeof(prize_distribution) = 'object'),
  check (jsonb_typeof(confidence_interval) = 'object'),
  check (canonical_evidence_hash like 'sha256:%'),
  check (signing_metadata is null or jsonb_typeof(signing_metadata) = 'object')
);

create index idx_statistical_validation_artifact
  on game_engine.statistical_validation_results(target_artifact_type, target_artifact_id, target_artifact_version);

create index idx_statistical_validation_type_artifact_hash
  on game_engine.statistical_validation_results(validation_type, target_artifact_type, target_artifact_hash);

create index idx_statistical_validation_result_hash
  on game_engine.statistical_validation_results(canonical_result_hash);

create index idx_statistical_validation_status
  on game_engine.statistical_validation_results(result_status);

create index idx_simulation_evidence_outcome_strategy
  on game_engine.simulation_evidence(outcome_strategy_id, outcome_strategy_version);

create index idx_simulation_evidence_math_model
  on game_engine.simulation_evidence(math_model_id, math_model_version);

create index idx_simulation_evidence_paytable
  on game_engine.simulation_evidence(paytable_id, paytable_version);

create index idx_simulation_evidence_rng_provider
  on game_engine.simulation_evidence(rng_provider_id, rng_provider_version);

create index idx_simulation_evidence_hash
  on game_engine.simulation_evidence(canonical_evidence_hash);

create or replace function game_engine.validate_statistical_validation_result()
returns trigger
language plpgsql
as $$
begin
  if new.result_status <> 'Pass' and new.certification_ready then
    raise exception 'Only passing statistical validations may be marked certification ready';
  end if;

  if new.result_status = 'Inconclusive' and new.certification_ready then
    raise exception 'Inconclusive statistical validations do not certify an artifact';
  end if;

  if new.target_artifact_type = 'OutcomeStrategy' then
    if not exists (
      select 1
      from game_engine.outcome_strategy_definitions
      where strategy_id = new.target_artifact_id
        and strategy_version = new.target_artifact_version
        and content_hash = new.target_artifact_hash
    ) then
      raise exception 'Outcome strategy statistical validation target is invalid';
    end if;
  elsif new.target_artifact_type = 'RngProvider' then
    if not exists (
      select 1
      from game_engine.rng_provider_definitions
      where provider_id = new.target_artifact_id
        and provider_version = new.target_artifact_version
        and content_hash = new.target_artifact_hash
    ) then
      raise exception 'RNG provider statistical validation target is invalid';
    end if;
  elsif new.target_artifact_type = 'MathModel' then
    if not exists (
      select 1
      from game_engine.math_model_definitions
      where math_model_id = new.target_artifact_id
        and version = new.target_artifact_version
        and content_hash = new.target_artifact_hash
    ) then
      raise exception 'Math model statistical validation target is invalid';
    end if;
  elsif new.target_artifact_type = 'Paytable' then
    if not exists (
      select 1
      from game_engine.paytable_definitions
      where paytable_id = new.target_artifact_id
        and version = new.target_artifact_version
        and content_hash = new.target_artifact_hash
    ) then
      raise exception 'Paytable statistical validation target is invalid';
    end if;
  elsif new.target_artifact_type = 'CertificationPack' then
    if not exists (
      select 1
      from game_engine.certification_packs
      where certification_pack_id = new.target_artifact_id
        and certification_version = new.target_artifact_version
        and content_hash = new.target_artifact_hash
    ) then
      raise exception 'Certification pack statistical validation target is invalid';
    end if;
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_simulation_evidence()
returns trigger
language plpgsql
as $$
declare
  rng_provider_type text;
begin
  if new.production_outcome_evidence then
    raise exception 'Simulation evidence can never be used as production outcome evidence';
  end if;

  if new.simulation_mode = 'ProductionDisabled' then
    raise exception 'Production simulation evidence mode is disabled';
  end if;

  if not exists (
    select 1
    from game_engine.outcome_strategy_definitions
    where strategy_id = new.outcome_strategy_id
      and strategy_version = new.outcome_strategy_version
      and content_hash = new.outcome_strategy_hash
  ) then
    raise exception 'Simulation outcome strategy reference is invalid';
  end if;

  if not exists (
    select 1
    from game_engine.math_model_definitions
    where math_model_id = new.math_model_id
      and version = new.math_model_version
      and content_hash = new.math_model_hash
  ) then
    raise exception 'Simulation math model reference is invalid';
  end if;

  if not exists (
    select 1
    from game_engine.paytable_definitions
    where paytable_id = new.paytable_id
      and version = new.paytable_version
      and content_hash = new.paytable_hash
      and math_model_id = new.math_model_id
      and math_model_version = new.math_model_version
  ) then
    raise exception 'Simulation paytable reference is invalid';
  end if;

  select provider_type
    into rng_provider_type
  from game_engine.rng_provider_definitions
  where provider_id = new.rng_provider_id
    and provider_version = new.rng_provider_version
    and content_hash = new.rng_provider_hash;

  if rng_provider_type is null then
    raise exception 'Simulation RNG provider reference is invalid';
  end if;

  if rng_provider_type in ('TEST_DETERMINISTIC', 'SIMULATION') and new.simulation_mode not in ('DryRun', 'Simulation') then
    raise exception 'Deterministic and simulation RNG providers are allowed only for dry-run/simulation evidence';
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_statistical_validation_result_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.statistical_validation_results is append-only; create a new validation result instead';
end;
$$;

create or replace function game_engine.prevent_simulation_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.simulation_evidence is append-only; create new simulation evidence instead';
end;
$$;

create trigger trg_validate_statistical_validation_result
before insert on game_engine.statistical_validation_results
for each row execute function game_engine.validate_statistical_validation_result();

create trigger trg_prevent_statistical_validation_result_update
before update on game_engine.statistical_validation_results
for each row execute function game_engine.prevent_statistical_validation_result_mutation();

create trigger trg_prevent_statistical_validation_result_delete
before delete on game_engine.statistical_validation_results
for each row execute function game_engine.prevent_statistical_validation_result_mutation();

create trigger trg_validate_simulation_evidence
before insert on game_engine.simulation_evidence
for each row execute function game_engine.validate_simulation_evidence();

create trigger trg_prevent_simulation_evidence_update
before update on game_engine.simulation_evidence
for each row execute function game_engine.prevent_simulation_evidence_mutation();

create trigger trg_prevent_simulation_evidence_delete
before delete on game_engine.simulation_evidence
for each row execute function game_engine.prevent_simulation_evidence_mutation();

comment on table game_engine.statistical_validation_results is
  'Append-only statistical validation evidence for Outcome/Math Authority governance. Inconclusive and failed results cannot certify artifacts.';

comment on table game_engine.simulation_evidence is
  'Append-only simulation evidence for outcome/math validation. Simulation evidence can never be production outcome evidence.';
