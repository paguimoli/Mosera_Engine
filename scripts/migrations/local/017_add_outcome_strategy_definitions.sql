create table game_engine.outcome_strategy_definitions (
  id uuid primary key,
  strategy_id text not null,
  strategy_version text not null,
  primitive_graph jsonb not null,
  input_schema jsonb not null default '{}'::jsonb,
  output_schema jsonb not null default '{}'::jsonb,
  constraints jsonb not null default '{}'::jsonb,
  jurisdiction_profile_references jsonb not null default '[]'::jsonb,
  lifecycle_state text not null,
  content_hash text not null,
  certification_binding_placeholder text,
  signature_metadata jsonb,
  created_at timestamptz not null default now(),
  constraint ux_outcome_strategy_definitions_strategy_version unique (strategy_id, strategy_version),
  constraint ux_outcome_strategy_definitions_content_hash unique (content_hash),
  check (jsonb_typeof(primitive_graph) = 'array'),
  check (jsonb_typeof(input_schema) = 'object'),
  check (jsonb_typeof(output_schema) = 'object'),
  check (jsonb_typeof(constraints) = 'object'),
  check (jsonb_typeof(jurisdiction_profile_references) = 'array'),
  check (signature_metadata is null or jsonb_typeof(signature_metadata) = 'object'),
  check (lifecycle_state in ('Draft', 'InternalReview', 'SimulationCertified', 'CertificationPending', 'Certified', 'GovernanceApproved', 'ProductionActive', 'Suspended', 'Retired', 'Superseded'))
);

create index idx_outcome_strategy_definitions_strategy_version
  on game_engine.outcome_strategy_definitions(strategy_id, strategy_version);

create index idx_outcome_strategy_definitions_content_hash
  on game_engine.outcome_strategy_definitions(content_hash);

create index idx_outcome_strategy_definitions_lifecycle_state
  on game_engine.outcome_strategy_definitions(lifecycle_state);

create or replace function game_engine.outcome_strategy_has_forbidden_fields(payload jsonb)
returns boolean
language sql
immutable
as $$
  select payload::text ~* '"(math|mathModel|mathModelReference|rtp|returnToPlayer|paytable|paytableReference|payout|payouts|odds)"[[:space:]]*:';
$$;

create or replace function game_engine.validate_outcome_strategy_definition()
returns trigger
language plpgsql
as $$
declare
  primitive jsonb;
  primitive_type text;
  node_id text;
  min_number integer;
  max_number integer;
  draw_count integer;
  range_size integer;
  duplicate_count integer;
  invalid_count integer;
begin
  if jsonb_array_length(new.primitive_graph) = 0 then
    raise exception 'outcome_strategy_definitions.primitive_graph must contain at least one primitive';
  end if;

  if game_engine.outcome_strategy_has_forbidden_fields(new.primitive_graph)
    or game_engine.outcome_strategy_has_forbidden_fields(new.input_schema)
    or game_engine.outcome_strategy_has_forbidden_fields(new.output_schema)
    or game_engine.outcome_strategy_has_forbidden_fields(new.constraints) then
    raise exception 'Outcome DSL cannot declare math, RTP, paytable, odds, or payout fields';
  end if;

  select count(*) - count(distinct primitive_value->>'nodeId')
  into duplicate_count
  from jsonb_array_elements(new.primitive_graph) primitive_value;

  if duplicate_count > 0 then
    raise exception 'Outcome DSL primitive node ids must be unique';
  end if;

  for primitive in select value from jsonb_array_elements(new.primitive_graph)
  loop
    node_id := primitive->>'nodeId';
    primitive_type := primitive->>'primitiveType';

    if node_id is null or btrim(node_id) = '' then
      raise exception 'Outcome DSL primitive nodeId is required';
    end if;

    if primitive_type not in (
      'UniqueNumberSet',
      'OrderedNumberSequence',
      'UniqueSymbolSet',
      'OrderedSymbolSequence',
      'WeightedSelection',
      'ShufflePermutation',
      'DrawFromUrnDeckBag',
      'CompositeOutcomeGraph',
      'ConstraintValidation'
    ) then
      raise exception 'Outcome DSL primitive type % is unsupported', primitive_type;
    end if;

    if primitive_type in ('UniqueNumberSet', 'OrderedNumberSequence') then
      min_number := (primitive->>'minNumber')::integer;
      max_number := (primitive->>'maxNumber')::integer;
      draw_count := (primitive->>'count')::integer;
      range_size := max_number - min_number + 1;

      if min_number >= max_number then
        raise exception 'Outcome DSL number primitive requires minNumber less than maxNumber';
      end if;

      if draw_count <= 0 or draw_count > range_size then
        raise exception 'Outcome DSL number primitive count must be positive and within range size';
      end if;

      if primitive ? 'numbers' then
        select count(*)
        into invalid_count
        from jsonb_array_elements_text(primitive->'numbers') number_value
        where number_value::integer < min_number or number_value::integer > max_number;

        if invalid_count > 0 then
          raise exception 'Outcome DSL number primitive contains a number outside its configured range';
        end if;

        if primitive_type = 'UniqueNumberSet' then
          select count(*) - count(distinct number_value)
          into duplicate_count
          from jsonb_array_elements_text(primitive->'numbers') number_value;

          if duplicate_count > 0 then
            raise exception 'Outcome DSL unique number set cannot contain duplicate numbers';
          end if;
        end if;
      end if;
    end if;

    if primitive_type in ('UniqueSymbolSet', 'OrderedSymbolSequence', 'ShufflePermutation', 'DrawFromUrnDeckBag') then
      if not primitive ? 'symbols' or jsonb_array_length(primitive->'symbols') = 0 then
        raise exception 'Outcome DSL symbol primitive requires at least one symbol';
      end if;

      if primitive ? 'count' and (primitive->>'count')::integer <= 0 then
        raise exception 'Outcome DSL symbol primitive count must be greater than zero';
      end if;

      if primitive_type in ('UniqueSymbolSet', 'ShufflePermutation', 'DrawFromUrnDeckBag') then
        select count(*) - count(distinct symbol_value)
        into duplicate_count
        from jsonb_array_elements_text(primitive->'symbols') symbol_value;

        if duplicate_count > 0 then
          raise exception 'Outcome DSL unique symbol primitive cannot contain duplicate symbols';
        end if;

        if primitive ? 'count' and (primitive->>'count')::integer > jsonb_array_length(primitive->'symbols') then
          raise exception 'Outcome DSL unique symbol count cannot exceed symbol population';
        end if;
      end if;
    end if;

    if primitive_type = 'WeightedSelection' then
      if not primitive ? 'weightedOptions' or jsonb_array_length(primitive->'weightedOptions') = 0 then
        raise exception 'Outcome DSL weighted selection requires weightedOptions';
      end if;

      select count(*)
      into invalid_count
      from jsonb_array_elements(primitive->'weightedOptions') option_value
      where (option_value->>'weight')::numeric <= 0;

      if invalid_count > 0 then
        raise exception 'Outcome DSL weighted selection weights must be positive';
      end if;

      select count(*) - count(distinct option_value->>'symbol')
      into duplicate_count
      from jsonb_array_elements(primitive->'weightedOptions') option_value;

      if duplicate_count > 0 then
        raise exception 'Outcome DSL weighted selection symbols must be unique';
      end if;
    end if;
  end loop;

  select count(*)
  into invalid_count
  from jsonb_array_elements(new.primitive_graph) primitive
  cross join lateral jsonb_array_elements_text(coalesce(primitive.value->'dependsOn', '[]'::jsonb)) dependency
  where not exists (
    select 1
    from jsonb_array_elements(new.primitive_graph) declared
    where declared.value->>'nodeId' = dependency.value
  );

  if invalid_count > 0 then
    raise exception 'Outcome DSL composite graph references an undeclared dependency';
  end if;

  if exists (
    with recursive
      nodes as (
        select
          primitive.value->>'nodeId' as node_id,
          coalesce(primitive.value->'dependsOn', '[]'::jsonb) as depends_on
        from jsonb_array_elements(new.primitive_graph) primitive
      ),
      walk(origin, node_id, path, cycle) as (
        select
          nodes.node_id,
          dependency.value,
          array[nodes.node_id],
          dependency.value = nodes.node_id
        from nodes
        cross join lateral jsonb_array_elements_text(nodes.depends_on) dependency
        union all
        select
          walk.origin,
          dependency.value,
          walk.path || dependency.value,
          dependency.value = any(walk.path)
        from walk
        join nodes on nodes.node_id = walk.node_id
        cross join lateral jsonb_array_elements_text(nodes.depends_on) dependency
        where not walk.cycle
      )
    select 1 from walk where cycle
  ) then
    raise exception 'Outcome DSL composite graph must be acyclic';
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_outcome_strategy_definition_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.outcome_strategy_definitions is append-only; create a new strategy version instead';
end;
$$;

create trigger trg_validate_outcome_strategy_definition
before insert on game_engine.outcome_strategy_definitions
for each row execute function game_engine.validate_outcome_strategy_definition();

create trigger trg_prevent_outcome_strategy_definition_update
before update on game_engine.outcome_strategy_definitions
for each row execute function game_engine.prevent_outcome_strategy_definition_mutation();

create trigger trg_prevent_outcome_strategy_definition_delete
before delete on game_engine.outcome_strategy_definitions
for each row execute function game_engine.prevent_outcome_strategy_definition_mutation();

comment on table game_engine.outcome_strategy_definitions is
  'Append-only Outcome DSL v1 strategy definitions. Strategies define primitive outcome contracts only and cannot declare math, RTP, paytable, odds, or payout behavior.';
