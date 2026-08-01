begin;

create table ticket_authority.liability_limit_configurations (
  configuration_id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id),
  brand_id uuid not null references platform.brands(id),
  scope_type text not null check (scope_type in (
    'TENANT', 'MASTER_AGENT', 'AGENT', 'PLAYER', 'DRAW',
    'PRODUCT', 'GAME', 'WAGER_TYPE'
  )),
  scope_reference text not null,
  maximum_wager_minor bigint not null check (maximum_wager_minor > 0),
  maximum_theoretical_payout_minor bigint not null
    check (maximum_theoretical_payout_minor > 0),
  maximum_exposure_minor bigint not null check (maximum_exposure_minor > 0),
  status text not null check (status in ('Active', 'Suspended', 'Retired', 'Superseded')),
  effective_from timestamptz not null,
  effective_to timestamptz,
  version integer not null check (version > 0),
  supersedes_configuration_id uuid
    references ticket_authority.liability_limit_configurations(configuration_id),
  content_hash text not null unique check (content_hash like 'sha256:%'),
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ck_liability_configuration_effective_window
    check (effective_to is null or effective_to > effective_from),
  constraint ux_liability_configuration_scope_version
    unique (tenant_id, brand_id, scope_type, scope_reference, version)
);

create index idx_liability_configuration_resolution
  on ticket_authority.liability_limit_configurations(
    tenant_id, brand_id, scope_type, scope_reference,
    effective_from desc, version desc
  );

create table ticket_authority.liability_decisions (
  decision_id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  canonical_intent_hash text not null check (canonical_intent_hash like 'sha256:%'),
  ticket_id uuid unique references ticket_authority.tickets(ticket_id),
  outcome text not null check (outcome in ('ALLOWED', 'REJECTED')),
  reason_code text not null,
  tenant_id uuid not null references platform.tenants(id),
  brand_id uuid not null references platform.brands(id),
  player_account_id uuid not null references public.accounts(id),
  agent_account_id uuid references public.accounts(id),
  master_agent_account_id uuid references public.accounts(id),
  draw_id uuid not null references game_engine.draw_schedules(id),
  product_id uuid not null references game_engine.game_definitions(id),
  game_code text not null,
  game_definition_version_id uuid not null
    references game_engine.game_definition_versions(id),
  game_definition_hash text not null,
  paytable_definition_id uuid not null references game_engine.paytable_definitions(id),
  paytable_version text not null,
  paytable_hash text not null,
  total_wager_minor bigint not null check (total_wager_minor > 0),
  theoretical_payout_minor bigint not null check (theoretical_payout_minor > 0),
  wager_liability jsonb not null,
  configuration_references jsonb not null,
  exposure_before jsonb not null,
  exposure_after jsonb not null,
  decision_hash text not null check (decision_hash like 'sha256:%'),
  decided_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint ck_liability_decision_ticket_outcome check (
    (outcome = 'ALLOWED' and ticket_id is not null)
    or (outcome = 'REJECTED' and ticket_id is null)
  ),
  constraint ck_liability_decision_json check (
    jsonb_typeof(wager_liability) = 'array'
    and jsonb_typeof(configuration_references) = 'array'
    and jsonb_typeof(exposure_before) = 'object'
    and jsonb_typeof(exposure_after) = 'object'
  )
);

create index idx_liability_decisions_open_exposure
  on ticket_authority.liability_decisions(
    tenant_id, brand_id, draw_id, product_id, game_code, outcome
  );
create index idx_liability_decisions_player
  on ticket_authority.liability_decisions(player_account_id, outcome);
create index idx_liability_decisions_agent
  on ticket_authority.liability_decisions(agent_account_id, outcome)
  where agent_account_id is not null;
create index idx_liability_decisions_master_agent
  on ticket_authority.liability_decisions(master_agent_account_id, outcome)
  where master_agent_account_id is not null;

create or replace function ticket_authority.prevent_liability_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Ticket Liability Authority records are append-only.';
end;
$$;

create trigger trg_liability_configuration_mutation_guard
before update or delete on ticket_authority.liability_limit_configurations
for each row execute function ticket_authority.prevent_liability_evidence_mutation();

create trigger trg_liability_decision_mutation_guard
before update or delete on ticket_authority.liability_decisions
for each row execute function ticket_authority.prevent_liability_evidence_mutation();

create or replace function ticket_authority.validate_liability_configuration()
returns trigger
language plpgsql
as $$
declare
  v_account public.accounts%rowtype;
  v_previous ticket_authority.liability_limit_configurations%rowtype;
begin
  if btrim(new.scope_reference) = '' then
    raise exception 'Liability configuration scope reference is required.';
  end if;
  if not exists (
    select 1 from platform.brands brand
    where brand.id = new.brand_id and brand.tenant_id = new.tenant_id
  ) then
    raise exception 'Liability configuration brand is outside tenant scope.';
  end if;

  if new.scope_type = 'TENANT' then
    if new.scope_reference <> new.tenant_id::text then
      raise exception 'Tenant liability scope must reference its canonical tenant.';
    end if;
  elsif new.scope_type in ('MASTER_AGENT', 'AGENT', 'PLAYER') then
    begin
      select * into v_account
      from public.accounts
      where id = new.scope_reference::uuid
        and governance_managed
        and canonical_tenant_id = new.tenant_id
        and canonical_brand_id = new.brand_id;
    exception when invalid_text_representation then
      raise exception 'Hierarchy liability scope must reference a canonical account UUID.';
    end;
    if not found or v_account.account_type <> new.scope_type then
      raise exception 'Hierarchy liability scope does not match a canonical account.';
    end if;
  elsif new.scope_type = 'DRAW' then
    begin
      perform 1 from game_engine.draw_schedules
      where id = new.scope_reference::uuid;
    exception when invalid_text_representation then
      raise exception 'Draw liability scope must reference a canonical Draw UUID.';
    end;
    if not found then raise exception 'Draw liability scope is unavailable.'; end if;
  elsif new.scope_type = 'PRODUCT' then
    begin
      perform 1 from game_engine.game_definitions
      where id = new.scope_reference::uuid;
    exception when invalid_text_representation then
      raise exception 'Product liability scope must reference a canonical Product UUID.';
    end;
    if not found then raise exception 'Product liability scope is unavailable.'; end if;
  elsif new.scope_type = 'GAME' then
    if new.scope_reference <> lower(btrim(new.scope_reference))
       or not exists (
         select 1 from game_engine.game_definitions game
         where game.code = new.scope_reference
       ) then
      raise exception 'Game liability scope must reference a canonical game code.';
    end if;
  elsif new.scope_type = 'WAGER_TYPE' then
    if new.scope_reference <> lower(btrim(new.scope_reference)) then
      raise exception 'Wager-type liability scope must be normalized.';
    end if;
  end if;

  if new.supersedes_configuration_id is not null then
    select * into v_previous
    from ticket_authority.liability_limit_configurations
    where configuration_id = new.supersedes_configuration_id;
    if not found
       or row(v_previous.tenant_id, v_previous.brand_id, v_previous.scope_type,
              v_previous.scope_reference)
          is distinct from row(new.tenant_id, new.brand_id, new.scope_type,
                               new.scope_reference)
       or v_previous.version >= new.version then
      raise exception 'Liability supersession must advance the exact immutable scope.';
    end if;
  elsif new.version <> 1 then
    raise exception 'Non-initial liability configuration requires a supersession reference.';
  end if;

  return new;
end;
$$;

create trigger trg_validate_liability_configuration
before insert on ticket_authority.liability_limit_configurations
for each row execute function ticket_authority.validate_liability_configuration();

create or replace function ticket_authority.lock_liability_tenant()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'ticket-liability:' || new.tenant_id::text,
    0
  ));
  return new;
end;
$$;

create trigger trg_lock_liability_configuration_insert
before insert on ticket_authority.liability_limit_configurations
for each row execute function ticket_authority.lock_liability_tenant();

create or replace function ticket_authority.calculate_theoretical_liability(
  p_product_id uuid,
  p_paytable_definition_id uuid,
  p_items jsonb
)
returns table(
  game_definition_version_id uuid,
  game_definition_hash text,
  paytable_version text,
  paytable_hash text,
  total_wager_minor bigint,
  theoretical_payout_minor bigint,
  wager_liability jsonb
)
language plpgsql
as $$
declare
  v_product game_engine.game_definitions%rowtype;
  v_product_version game_engine.game_definition_versions%rowtype;
  v_paytable game_engine.paytable_definitions%rowtype;
  v_item jsonb;
  v_row jsonb;
  v_item_index integer := 0;
  v_stake bigint;
  v_item_max numeric;
  v_candidate numeric;
  v_cap numeric;
  v_rows integer;
  v_total_wager numeric := 0;
  v_total_payout numeric := 0;
  v_wagers jsonb := '[]'::jsonb;
begin
  select * into v_product
  from game_engine.game_definitions
  where id = p_product_id and active_version_id is not null;
  if not found then
    raise exception 'Liability requires an active immutable Game Definition.';
  end if;
  select * into v_product_version
  from game_engine.game_definition_versions
  where id = v_product.active_version_id
    and game_definition_id = v_product.id
    and effective_from <= clock_timestamp()
    and (effective_to is null or effective_to > clock_timestamp());
  if not found then
    raise exception 'Liability requires an effective immutable Game Definition version.';
  end if;
  select * into v_paytable
  from game_engine.paytable_definitions
  where id = p_paytable_definition_id
    and lifecycle_state = 'ProductionActive';
  if not found or v_paytable.version <> v_product_version.paytable_version then
    raise exception 'Liability requires the exact immutable ProductionActive Paytable version.';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Liability requires canonical wager items.';
  end if;

  v_cap := nullif(v_paytable.caps->>'maxPayout', '')::numeric;
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_stake := coalesce((v_item->>'stakeMinor')::bigint, 0);
    if v_stake <= 0
       or btrim(coalesce(v_item->>'wagerType', '')) = ''
       or btrim(coalesce(v_item->>'wagerVersion', '')) = '' then
      raise exception 'Liability wager item is invalid.';
    end if;
    v_item_max := null;
    v_rows := 0;
    for v_row in
      select value
      from jsonb_array_elements(
        v_paytable.prize_matrix_rows || v_paytable.bonus_side_bet_rows
      )
      where not (value ? 'wagerSchema')
         or lower(value->>'wagerSchema') in (
           lower(v_item->>'wagerType'),
           lower(v_item->>'wagerVersion'),
           lower((v_item->>'wagerType') || '-' || (v_item->>'wagerVersion'))
         )
    loop
      v_rows := v_rows + 1;
      if coalesce((v_row->>'payoutValue')::numeric, 0) > 0 then
        v_candidate := v_stake + round((v_row->>'payoutValue')::numeric);
      else
        v_candidate := round(v_stake * coalesce((v_row->>'multiplier')::numeric, 0));
      end if;
      if v_row ? 'maxPayout' then
        v_candidate := least(v_candidate, (v_row->>'maxPayout')::numeric);
      end if;
      if v_cap is not null then v_candidate := least(v_candidate, v_cap); end if;
      v_item_max := greatest(coalesce(v_item_max, 0), v_candidate);
    end loop;
    if v_rows = 0 or coalesce(v_item_max, 0) <= 0 then
      raise exception 'Immutable Paytable cannot determine maximum payout for wager type %.',
        v_item->>'wagerType';
    end if;

    v_total_wager := v_total_wager + v_stake;
    v_total_payout := v_total_payout + v_item_max;
    v_wagers := v_wagers || jsonb_build_array(jsonb_build_object(
      'itemIndex', v_item_index,
      'wagerType', lower(v_item->>'wagerType'),
      'wagerVersion', v_item->>'wagerVersion',
      'stakeMinor', v_stake,
      'theoreticalPayoutMinor', v_item_max::bigint
    ));
    v_item_index := v_item_index + 1;
  end loop;

  return query select
    v_product_version.id,
    v_product_version.definition_hash,
    v_paytable.version,
    v_paytable.content_hash,
    v_total_wager::bigint,
    v_total_payout::bigint,
    v_wagers;
exception when numeric_value_out_of_range then
  raise exception 'Theoretical liability exceeds the supported integer range.';
end;
$$;

create or replace function ticket_authority.evaluate_liability(
  p_tenant_id uuid,
  p_brand_id uuid,
  p_player_account_id uuid,
  p_agent_account_id uuid,
  p_master_agent_account_id uuid,
  p_draw_id uuid,
  p_product_id uuid,
  p_game_code text,
  p_paytable_definition_id uuid,
  p_items jsonb,
  p_availability_min_wager numeric,
  p_availability_max_wager numeric,
  p_canonical_intent_hash text,
  p_decided_at timestamptz
)
returns table(
  allowed boolean,
  reason_code text,
  game_definition_version_id uuid,
  game_definition_hash text,
  paytable_version text,
  paytable_hash text,
  total_wager_minor bigint,
  theoretical_payout_minor bigint,
  wager_liability jsonb,
  configuration_references jsonb,
  exposure_before jsonb,
  exposure_after jsonb,
  decision_hash text
)
language plpgsql
as $$
declare
  v_math record;
  v_scope jsonb;
  v_configuration ticket_authority.liability_limit_configurations%rowtype;
  v_required_scopes jsonb;
  v_configurations jsonb := '[]'::jsonb;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_current_exposure bigint;
  v_increment bigint;
  v_scope_wager bigint;
  v_scope_payout bigint;
  v_reason text := 'LIABILITY_ALLOWED';
  v_allowed boolean := true;
  v_key text;
  v_wager_type text;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'ticket-liability:' || p_tenant_id::text,
    0
  ));

  select * into v_math
  from ticket_authority.calculate_theoretical_liability(
    p_product_id, p_paytable_definition_id, p_items
  );

  if p_availability_min_wager is not null
     and v_math.total_wager_minor < round(p_availability_min_wager * 100)::bigint then
    v_allowed := false;
    v_reason := 'BELOW_EFFECTIVE_MINIMUM_WAGER';
  elsif p_availability_max_wager is not null
     and v_math.total_wager_minor > round(p_availability_max_wager * 100)::bigint then
    v_allowed := false;
    v_reason := 'ABOVE_EFFECTIVE_MAXIMUM_WAGER';
  end if;

  v_required_scopes := jsonb_build_array(
    jsonb_build_object('type', 'TENANT', 'reference', p_tenant_id::text),
    jsonb_build_object('type', 'PLAYER', 'reference', p_player_account_id::text),
    jsonb_build_object('type', 'DRAW', 'reference', p_draw_id::text),
    jsonb_build_object('type', 'PRODUCT', 'reference', p_product_id::text),
    jsonb_build_object('type', 'GAME', 'reference', lower(p_game_code))
  );
  if p_master_agent_account_id is not null then
    v_required_scopes := v_required_scopes || jsonb_build_array(
      jsonb_build_object('type', 'MASTER_AGENT', 'reference', p_master_agent_account_id::text)
    );
  end if;
  if p_agent_account_id is not null then
    v_required_scopes := v_required_scopes || jsonb_build_array(
      jsonb_build_object('type', 'AGENT', 'reference', p_agent_account_id::text)
    );
  end if;

  for v_scope in select value from jsonb_array_elements(v_required_scopes)
  loop
    select * into v_configuration
    from ticket_authority.liability_limit_configurations configuration
    where configuration.tenant_id = p_tenant_id
      and configuration.brand_id = p_brand_id
      and configuration.scope_type = v_scope->>'type'
      and configuration.scope_reference = v_scope->>'reference'
      and configuration.effective_from <= p_decided_at
      and (configuration.effective_to is null
        or configuration.effective_to > p_decided_at)
    order by configuration.version desc, configuration.effective_from desc,
      configuration.created_at desc, configuration.configuration_id
    limit 1;

    if not found or v_configuration.status <> 'Active' then
      v_allowed := false;
      v_reason := 'LIABILITY_CONFIGURATION_UNAVAILABLE:' ||
        (v_scope->>'type') || ':' || (v_scope->>'reference');
      exit;
    end if;

    v_configurations := v_configurations || jsonb_build_array(jsonb_build_object(
      'configurationId', v_configuration.configuration_id,
      'scopeType', v_configuration.scope_type,
      'scopeReference', v_configuration.scope_reference,
      'version', v_configuration.version,
      'contentHash', v_configuration.content_hash
    ));

    if v_math.total_wager_minor > v_configuration.maximum_wager_minor then
      v_allowed := false;
      v_reason := 'MAXIMUM_WAGER_EXCEEDED:' || v_configuration.scope_type;
      exit;
    end if;
    if v_math.theoretical_payout_minor >
       v_configuration.maximum_theoretical_payout_minor then
      v_allowed := false;
      v_reason := 'MAXIMUM_THEORETICAL_PAYOUT_EXCEEDED:' ||
        v_configuration.scope_type;
      exit;
    end if;

    select coalesce(sum(decision.theoretical_payout_minor), 0)::bigint
    into v_current_exposure
    from ticket_authority.liability_decisions decision
    join ticket_authority.tickets ticket on ticket.ticket_id = decision.ticket_id
    where decision.outcome = 'ALLOWED'
      and ticket.status in ('ACCEPTED', 'AWAITING_DRAW', 'CLOSED', 'SETTLEMENT_PENDING')
      and case v_configuration.scope_type
        when 'TENANT' then ticket.tenant_id::text = v_configuration.scope_reference
        when 'MASTER_AGENT' then ticket.master_agent_account_id::text = v_configuration.scope_reference
        when 'AGENT' then ticket.agent_account_id::text = v_configuration.scope_reference
        when 'PLAYER' then ticket.player_account_id::text = v_configuration.scope_reference
        when 'DRAW' then ticket.draw_id::text = v_configuration.scope_reference
        when 'PRODUCT' then ticket.product_id::text = v_configuration.scope_reference
        when 'GAME' then ticket.game_code = v_configuration.scope_reference
        else false
      end;
    v_increment := v_math.theoretical_payout_minor;
    v_key := v_configuration.scope_type || ':' || v_configuration.scope_reference;
    v_before := v_before || jsonb_build_object(v_key, v_current_exposure);
    v_after := v_after || jsonb_build_object(v_key, v_current_exposure + v_increment);
    if v_current_exposure + v_increment > v_configuration.maximum_exposure_minor then
      v_allowed := false;
      v_reason := 'MAXIMUM_EXPOSURE_EXCEEDED:' || v_configuration.scope_type;
      exit;
    end if;
  end loop;

  if v_allowed then
    for v_wager_type in
      select distinct value->>'wagerType'
      from jsonb_array_elements(v_math.wager_liability)
    loop
      select * into v_configuration
      from ticket_authority.liability_limit_configurations configuration
      where configuration.tenant_id = p_tenant_id
        and configuration.brand_id = p_brand_id
        and configuration.scope_type = 'WAGER_TYPE'
        and configuration.scope_reference = v_wager_type
        and configuration.effective_from <= p_decided_at
        and (configuration.effective_to is null
          or configuration.effective_to > p_decided_at)
      order by configuration.version desc, configuration.effective_from desc,
        configuration.created_at desc, configuration.configuration_id
      limit 1;
      if not found then continue; end if;
      if v_configuration.status <> 'Active' then
        v_allowed := false;
        v_reason := 'LIABILITY_CONFIGURATION_UNAVAILABLE:WAGER_TYPE:' || v_wager_type;
        exit;
      end if;
      v_configurations := v_configurations || jsonb_build_array(jsonb_build_object(
        'configurationId', v_configuration.configuration_id,
        'scopeType', v_configuration.scope_type,
        'scopeReference', v_configuration.scope_reference,
        'version', v_configuration.version,
        'contentHash', v_configuration.content_hash
      ));
      select
        coalesce(sum((value->>'stakeMinor')::bigint), 0)::bigint,
        coalesce(sum((value->>'theoreticalPayoutMinor')::bigint), 0)::bigint
      into v_scope_wager, v_scope_payout
      from jsonb_array_elements(v_math.wager_liability)
      where value->>'wagerType' = v_wager_type;
      if v_scope_wager > v_configuration.maximum_wager_minor then
        v_allowed := false;
        v_reason := 'MAXIMUM_WAGER_EXCEEDED:WAGER_TYPE';
        exit;
      end if;
      if v_scope_payout > v_configuration.maximum_theoretical_payout_minor then
        v_allowed := false;
        v_reason := 'MAXIMUM_THEORETICAL_PAYOUT_EXCEEDED:WAGER_TYPE';
        exit;
      end if;
      select coalesce(sum((wager->>'theoreticalPayoutMinor')::bigint), 0)::bigint
      into v_current_exposure
      from ticket_authority.liability_decisions decision
      join ticket_authority.tickets ticket on ticket.ticket_id = decision.ticket_id
      cross join lateral jsonb_array_elements(decision.wager_liability) wager
      where decision.outcome = 'ALLOWED'
        and ticket.status in ('ACCEPTED', 'AWAITING_DRAW', 'CLOSED', 'SETTLEMENT_PENDING')
        and ticket.tenant_id = p_tenant_id
        and ticket.brand_id = p_brand_id
        and wager->>'wagerType' = v_wager_type;
      v_key := 'WAGER_TYPE:' || v_wager_type;
      v_before := v_before || jsonb_build_object(v_key, v_current_exposure);
      v_after := v_after || jsonb_build_object(v_key, v_current_exposure + v_scope_payout);
      if v_current_exposure + v_scope_payout > v_configuration.maximum_exposure_minor then
        v_allowed := false;
        v_reason := 'MAXIMUM_EXPOSURE_EXCEEDED:WAGER_TYPE';
        exit;
      end if;
    end loop;
  end if;

  return query select
    v_allowed,
    v_reason,
    v_math.game_definition_version_id,
    v_math.game_definition_hash,
    v_math.paytable_version,
    v_math.paytable_hash,
    v_math.total_wager_minor,
    v_math.theoretical_payout_minor,
    v_math.wager_liability,
    v_configurations,
    v_before,
    v_after,
    ticket_authority.hash_json(jsonb_build_object(
      'canonicalIntentHash', p_canonical_intent_hash,
      'allowed', v_allowed,
      'reasonCode', v_reason,
      'gameDefinitionVersionId', v_math.game_definition_version_id,
      'gameDefinitionHash', v_math.game_definition_hash,
      'paytableVersion', v_math.paytable_version,
      'paytableHash', v_math.paytable_hash,
      'totalWagerMinor', v_math.total_wager_minor,
      'theoreticalPayoutMinor', v_math.theoretical_payout_minor,
      'wagerLiability', v_math.wager_liability,
      'configurationReferences', v_configurations,
      'exposureBefore', v_before,
      'exposureAfter', v_after
    ));
end;
$$;

do $$
declare
  v_identity regprocedure :=
    'ticket_authority.accept_ticket(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,text,text,text)'::regprocedure;
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(v_identity) into v_definition;
  v_updated := replace(
    v_definition,
    E'  v_existing_request ticket_authority.acceptance_requests%rowtype;',
    E'  v_existing_request ticket_authority.acceptance_requests%rowtype;\n  v_existing_liability ticket_authority.liability_decisions%rowtype;\n  v_liability record;'
  );
  if v_updated = v_definition then
    raise exception 'Ticket Liability Authority could not add canonical state declarations.';
  end if;
  v_definition := v_updated;

  v_updated := replace(
    v_definition,
    E'    return v_result;\n  end if;\n\n  select * into v_account',
    E'    return v_result;\n  end if;\n\n  select * into v_existing_liability\n  from ticket_authority.liability_decisions\n  where idempotency_key = btrim(p_idempotency_key);\n  if found then\n    if v_existing_liability.canonical_intent_hash <> v_intent_hash then\n      raise exception ''ticket idempotency key conflicts with a different canonical request'';\n    end if;\n    if v_existing_liability.outcome = ''REJECTED'' then\n      return jsonb_build_object(\n        ''accepted'', false,\n        ''duplicate'', true,\n        ''reasonCode'', v_existing_liability.reason_code,\n        ''liabilityDecisionId'', v_existing_liability.decision_id,\n        ''liabilityDecisionHash'', v_existing_liability.decision_hash\n      );\n    end if;\n    raise exception ''allowed liability decision is missing canonical ticket evidence'';\n  end if;\n\n  select * into v_account'
  );
  if v_updated = v_definition then
    raise exception 'Ticket Liability Authority could not add rejection idempotency.';
  end if;
  v_definition := v_updated;

  v_updated := replace(
    v_definition,
    E'  if v_availability.effective_min_wager is not null\n     and v_total < round(v_availability.effective_min_wager * 100)::bigint then\n    raise exception ''ticket total stake is below the effective minimum wager'';\n  end if;\n  if v_availability.effective_max_wager is not null\n     and v_total > round(v_availability.effective_max_wager * 100)::bigint then\n    raise exception ''ticket total stake exceeds the effective maximum wager'';\n  end if;',
    E'  select * into v_liability\n  from ticket_authority.evaluate_liability(\n    v_account.canonical_tenant_id,\n    v_account.canonical_brand_id,\n    p_player_account_id,\n    v_agent_id,\n    v_master_agent_id,\n    p_draw_id,\n    p_product_id,\n    v_product.code,\n    p_paytable_definition_id,\n    p_items,\n    v_availability.effective_min_wager,\n    v_availability.effective_max_wager,\n    v_intent_hash,\n    v_decided_at\n  );\n  if not v_liability.allowed then\n    insert into ticket_authority.liability_decisions (\n      idempotency_key, canonical_intent_hash, outcome, reason_code,\n      tenant_id, brand_id, player_account_id, agent_account_id,\n      master_agent_account_id, draw_id, product_id, game_code,\n      game_definition_version_id, game_definition_hash,\n      paytable_definition_id, paytable_version, paytable_hash,\n      total_wager_minor, theoretical_payout_minor, wager_liability,\n      configuration_references, exposure_before, exposure_after,\n      decision_hash, decided_at\n    ) values (\n      btrim(p_idempotency_key), v_intent_hash, ''REJECTED'',\n      v_liability.reason_code, v_account.canonical_tenant_id,\n      v_account.canonical_brand_id, p_player_account_id, v_agent_id,\n      v_master_agent_id, p_draw_id, p_product_id, v_product.code,\n      v_liability.game_definition_version_id, v_liability.game_definition_hash,\n      p_paytable_definition_id, v_liability.paytable_version,\n      v_liability.paytable_hash, v_liability.total_wager_minor,\n      v_liability.theoretical_payout_minor, v_liability.wager_liability,\n      v_liability.configuration_references, v_liability.exposure_before,\n      v_liability.exposure_after, v_liability.decision_hash, v_decided_at\n    ) returning * into v_existing_liability;\n    return jsonb_build_object(\n      ''accepted'', false,\n      ''duplicate'', false,\n      ''reasonCode'', v_liability.reason_code,\n      ''liabilityDecisionId'', v_existing_liability.decision_id,\n      ''liabilityDecisionHash'', v_existing_liability.decision_hash\n    );\n  end if;'
  );
  if v_updated = v_definition then
    raise exception 'Ticket Liability Authority could not replace duplicate wager-limit decisions.';
  end if;
  v_definition := v_updated;

  v_updated := replace(
    v_definition,
    E'  insert into ticket_authority.acceptance_requests(',
    E'  insert into ticket_authority.liability_decisions (\n    idempotency_key, canonical_intent_hash, ticket_id, outcome, reason_code,\n    tenant_id, brand_id, player_account_id, agent_account_id,\n    master_agent_account_id, draw_id, product_id, game_code,\n    game_definition_version_id, game_definition_hash,\n    paytable_definition_id, paytable_version, paytable_hash,\n    total_wager_minor, theoretical_payout_minor, wager_liability,\n    configuration_references, exposure_before, exposure_after,\n    decision_hash, decided_at\n  ) values (\n    btrim(p_idempotency_key), v_intent_hash, (v_result->>''ticketId'')::uuid,\n    ''ALLOWED'', v_liability.reason_code, v_account.canonical_tenant_id,\n    v_account.canonical_brand_id, p_player_account_id, v_agent_id,\n    v_master_agent_id, p_draw_id, p_product_id, v_product.code,\n    v_liability.game_definition_version_id, v_liability.game_definition_hash,\n    p_paytable_definition_id, v_liability.paytable_version,\n    v_liability.paytable_hash, v_liability.total_wager_minor,\n    v_liability.theoretical_payout_minor, v_liability.wager_liability,\n    v_liability.configuration_references, v_liability.exposure_before,\n    v_liability.exposure_after, v_liability.decision_hash, v_decided_at\n  );\n\n  insert into ticket_authority.acceptance_requests('
  );
  if v_updated = v_definition then
    raise exception 'Ticket Liability Authority could not bind allowed decision evidence.';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_identity regprocedure :=
    'ticket_authority.ticket_readiness()'::regprocedure;
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(v_identity) into v_definition;
  v_updated := replace(
    v_definition,
    E'    union all\n    select \'legacy_production_routes_disabled\', true, 0::bigint',
    E'    union all\n    select \'liability_migration_state\',\n      exists (\n        select 1 from platform_migrations.migration_history\n        where migration_id = \'102_add_ticket_liability_authority\'\n          and status = \'APPLIED\'\n      ),\n      case when exists (\n        select 1 from platform_migrations.migration_history\n        where migration_id = \'102_add_ticket_liability_authority\'\n          and status = \'APPLIED\'\n      ) then 0 else 1 end::bigint\n    union all\n    select \'liability_decision_integrity\',\n      count(*) = 0, count(*)\n    from ticket_authority.tickets ticket\n    join platform_migrations.migration_history migration\n      on migration.migration_id = \'102_add_ticket_liability_authority\'\n     and migration.status = \'APPLIED\'\n     and ticket.accepted_at >= migration.applied_at\n    where not exists (\n      select 1\n      from ticket_authority.liability_decisions decision\n      join ticket_authority.acceptance_requests request\n        on request.ticket_id = ticket.ticket_id\n       and request.canonical_intent_hash = decision.canonical_intent_hash\n      where decision.ticket_id = ticket.ticket_id\n        and decision.outcome = \'ALLOWED\'\n        and decision.paytable_definition_id = ticket.paytable_definition_id\n    )\n    union all\n    select \'legacy_production_routes_disabled\', true, 0::bigint'
  );
  if v_updated = v_definition then
    raise exception 'Ticket Liability Authority could not extend ticket readiness.';
  end if;
  execute v_updated;
end;
$$;

comment on table ticket_authority.liability_limit_configurations is
  'Append-only server-derived liability limits. Required base scopes fail closed; wager-type limits are optional and narrowing.';
comment on table ticket_authority.liability_decisions is
  'Immutable Ticket Liability Authority decisions. Rejected decisions have no ticket, reservation, or financial effect.';
comment on function ticket_authority.evaluate_liability(
  uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,text,timestamptz
) is
  'Sole Ticket Liability Authority. Locks tenant exposure, derives immutable paytable maximum payout, and intersects hierarchy/draw/product/game limits.';

commit;
