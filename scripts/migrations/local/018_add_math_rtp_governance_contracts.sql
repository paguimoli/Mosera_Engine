create table game_engine.math_model_definitions (
  id uuid primary key,
  math_model_id text not null,
  version text not null,
  game_family_compatibility jsonb not null default '[]'::jsonb,
  supported_wager_schemas jsonb not null default '[]'::jsonb,
  expected_rtp numeric(12, 8) not null,
  expected_value numeric(18, 8) not null,
  volatility_profile text not null,
  hit_frequency numeric(12, 8) not null,
  prize_liability_profile jsonb not null default '{}'::jsonb,
  jackpot_contribution_model jsonb not null default '{}'::jsonb,
  rounding_policy jsonb not null default '{}'::jsonb,
  currency_minor_unit_policy jsonb not null default '{}'::jsonb,
  jurisdiction_compatibility jsonb not null default '[]'::jsonb,
  lifecycle_state text not null,
  content_hash text not null,
  certification_binding_placeholder text,
  signature_metadata jsonb,
  created_at timestamptz not null default now(),
  constraint ux_math_model_definitions_model_version unique (math_model_id, version),
  constraint ux_math_model_definitions_content_hash unique (content_hash),
  check (jsonb_typeof(game_family_compatibility) = 'array'),
  check (jsonb_typeof(supported_wager_schemas) = 'array'),
  check (expected_rtp > 0 and expected_rtp <= 1),
  check (hit_frequency >= 0 and hit_frequency <= 1),
  check (jsonb_typeof(prize_liability_profile) = 'object'),
  check (jsonb_typeof(jackpot_contribution_model) = 'object'),
  check (jsonb_typeof(rounding_policy) = 'object'),
  check (jsonb_typeof(currency_minor_unit_policy) = 'object'),
  check (jsonb_typeof(jurisdiction_compatibility) = 'array'),
  check (signature_metadata is null or jsonb_typeof(signature_metadata) = 'object'),
  check (lifecycle_state in ('Draft', 'InternalReview', 'SimulationCertified', 'CertificationPending', 'Certified', 'GovernanceApproved', 'ProductionActive', 'Suspended', 'Retired', 'Superseded'))
);

create table game_engine.paytable_definitions (
  id uuid primary key,
  paytable_id text not null,
  version text not null,
  math_model_id text not null,
  math_model_version text not null,
  prize_matrix_rows jsonb not null,
  bonus_side_bet_rows jsonb not null default '[]'::jsonb,
  caps jsonb not null default '{}'::jsonb,
  lifecycle_state text not null,
  content_hash text not null,
  certification_binding_placeholder text,
  signature_metadata jsonb,
  created_at timestamptz not null default now(),
  constraint ux_paytable_definitions_paytable_version unique (paytable_id, version),
  constraint ux_paytable_definitions_content_hash unique (content_hash),
  check (jsonb_typeof(prize_matrix_rows) = 'array'),
  check (jsonb_typeof(bonus_side_bet_rows) = 'array'),
  check (jsonb_typeof(caps) = 'object'),
  check (signature_metadata is null or jsonb_typeof(signature_metadata) = 'object'),
  check (lifecycle_state in ('Draft', 'InternalReview', 'SimulationCertified', 'CertificationPending', 'Certified', 'GovernanceApproved', 'ProductionActive', 'Suspended', 'Retired', 'Superseded'))
);

create index idx_math_model_definitions_model_version
  on game_engine.math_model_definitions(math_model_id, version);

create index idx_math_model_definitions_content_hash
  on game_engine.math_model_definitions(content_hash);

create index idx_math_model_definitions_lifecycle_state
  on game_engine.math_model_definitions(lifecycle_state);

create index idx_paytable_definitions_paytable_version
  on game_engine.paytable_definitions(paytable_id, version);

create index idx_paytable_definitions_content_hash
  on game_engine.paytable_definitions(content_hash);

create index idx_paytable_definitions_math_model
  on game_engine.paytable_definitions(math_model_id, math_model_version);

create or replace function game_engine.math_governance_has_forbidden_fields(payload jsonb)
returns boolean
language sql
immutable
as $$
  select payload::text ~* '"(rng|random|randomness|entropy|seed|prng|outcome|outcomes|outcomeStrategy|outcomeReference)"[[:space:]]*:';
$$;

create or replace function game_engine.validate_math_model_definition()
returns trigger
language plpgsql
as $$
begin
  if jsonb_array_length(new.game_family_compatibility) = 0 then
    raise exception 'math_model_definitions.game_family_compatibility must contain at least one game family';
  end if;

  if jsonb_array_length(new.supported_wager_schemas) = 0 then
    raise exception 'math_model_definitions.supported_wager_schemas must contain at least one wager schema';
  end if;

  if game_engine.math_governance_has_forbidden_fields(new.prize_liability_profile)
    or game_engine.math_governance_has_forbidden_fields(new.jackpot_contribution_model)
    or game_engine.math_governance_has_forbidden_fields(new.rounding_policy)
    or game_engine.math_governance_has_forbidden_fields(new.currency_minor_unit_policy) then
    raise exception 'Math governance contracts cannot declare RNG, entropy, seed, or outcome fields';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_paytable_definition()
returns trigger
language plpgsql
as $$
declare
  invalid_count integer;
begin
  if jsonb_array_length(new.prize_matrix_rows) = 0 then
    raise exception 'paytable_definitions.prize_matrix_rows must contain at least one row';
  end if;

  if game_engine.math_governance_has_forbidden_fields(new.prize_matrix_rows)
    or game_engine.math_governance_has_forbidden_fields(new.bonus_side_bet_rows)
    or game_engine.math_governance_has_forbidden_fields(new.caps) then
    raise exception 'Math governance contracts cannot declare RNG, entropy, seed, or outcome fields';
  end if;

  select count(*)
  into invalid_count
  from jsonb_array_elements(new.prize_matrix_rows || new.bonus_side_bet_rows) row_value
  where coalesce((row_value->>'multiplier')::numeric, 0) < 0
    or coalesce((row_value->>'payoutValue')::numeric, 0) < 0
    or (
      coalesce((row_value->>'multiplier')::numeric, 0) = 0
      and coalesce((row_value->>'payoutValue')::numeric, 0) = 0
    )
    or (row_value ? 'maxPayout' and (row_value->>'maxPayout')::numeric <= 0);

  if invalid_count > 0 then
    raise exception 'Paytable prize rows require non-negative values and a positive multiplier or payout';
  end if;

  if new.caps ? 'maxPayout' and (new.caps->>'maxPayout')::numeric <= 0 then
    raise exception 'Paytable max payout cap must be positive when provided';
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_math_model_definition_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.math_model_definitions is append-only; create a new math model version instead';
end;
$$;

create or replace function game_engine.prevent_paytable_definition_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.paytable_definitions is append-only; create a new paytable version instead';
end;
$$;

create trigger trg_validate_math_model_definition
before insert on game_engine.math_model_definitions
for each row execute function game_engine.validate_math_model_definition();

create trigger trg_prevent_math_model_definition_update
before update on game_engine.math_model_definitions
for each row execute function game_engine.prevent_math_model_definition_mutation();

create trigger trg_prevent_math_model_definition_delete
before delete on game_engine.math_model_definitions
for each row execute function game_engine.prevent_math_model_definition_mutation();

create trigger trg_validate_paytable_definition
before insert on game_engine.paytable_definitions
for each row execute function game_engine.validate_paytable_definition();

create trigger trg_prevent_paytable_definition_update
before update on game_engine.paytable_definitions
for each row execute function game_engine.prevent_paytable_definition_mutation();

create trigger trg_prevent_paytable_definition_delete
before delete on game_engine.paytable_definitions
for each row execute function game_engine.prevent_paytable_definition_mutation();

comment on table game_engine.math_model_definitions is
  'Append-only Math Model v1 definitions. RTP, EV, volatility, liability, jackpot, rounding, and currency policies are versioned governance facts and cannot declare RNG or outcome controls.';

comment on table game_engine.paytable_definitions is
  'Append-only Paytable v1 definitions. Payout rows and caps are immutable versioned artifacts linked to math model references.';
