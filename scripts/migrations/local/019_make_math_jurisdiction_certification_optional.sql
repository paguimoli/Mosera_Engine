alter table game_engine.math_model_definitions
  rename column jurisdiction_compatibility to jurisdiction_profile_references;

alter table game_engine.math_model_definitions
  alter column jurisdiction_profile_references drop not null,
  alter column jurisdiction_profile_references drop default;

alter table game_engine.math_model_definitions
  add column rtp_policy_constraints jsonb,
  add column certification_binding_state text not null default 'None';

alter table game_engine.math_model_definitions
  add constraint chk_math_model_jurisdiction_profile_references_optional_array
    check (jurisdiction_profile_references is null or jsonb_typeof(jurisdiction_profile_references) = 'array'),
  add constraint chk_math_model_rtp_policy_constraints_optional_object
    check (rtp_policy_constraints is null or jsonb_typeof(rtp_policy_constraints) = 'object'),
  add constraint chk_math_model_certification_binding_state
    check (certification_binding_state in ('None', 'InternalVerified', 'LabSubmitted', 'Certified'));

alter table game_engine.math_model_definitions
  drop column certification_binding_placeholder;

alter table game_engine.paytable_definitions
  add column jurisdiction_profile_references jsonb,
  add column certification_binding_state text not null default 'None';

alter table game_engine.paytable_definitions
  add constraint chk_paytable_jurisdiction_profile_references_optional_array
    check (jurisdiction_profile_references is null or jsonb_typeof(jurisdiction_profile_references) = 'array'),
  add constraint chk_paytable_certification_binding_state
    check (certification_binding_state in ('None', 'InternalVerified', 'LabSubmitted', 'Certified'));

alter table game_engine.paytable_definitions
  drop column certification_binding_placeholder;

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
    or game_engine.math_governance_has_forbidden_fields(new.currency_minor_unit_policy)
    or game_engine.math_governance_has_forbidden_fields(coalesce(new.rtp_policy_constraints, '{}'::jsonb)) then
    raise exception 'Math governance contracts cannot declare RNG, entropy, seed, or outcome fields';
  end if;

  return new;
end;
$$;

comment on column game_engine.math_model_definitions.jurisdiction_profile_references is
  'Optional policy overlay references. Absence means the base math model is jurisdiction-neutral.';

comment on column game_engine.math_model_definitions.rtp_policy_constraints is
  'Optional jurisdiction/profile RTP policy constraints. Base RTP validation does not require this overlay.';

comment on column game_engine.math_model_definitions.certification_binding_state is
  'Optional certification state for governance evidence; None does not block draft or immutable version creation.';

comment on column game_engine.paytable_definitions.jurisdiction_profile_references is
  'Optional policy overlay references. Absence means the base paytable is jurisdiction-neutral.';

comment on column game_engine.paytable_definitions.certification_binding_state is
  'Optional certification state for governance evidence; None does not block immutable version creation.';
