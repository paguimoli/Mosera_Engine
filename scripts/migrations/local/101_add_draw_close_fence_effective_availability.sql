begin;

alter table platform.game_availability
  add column if not exists player_account_id uuid references public.accounts(id);

drop index if exists platform.ux_platform_game_availability_scope_game_version;
create unique index ux_platform_game_availability_scope_game_version
  on platform.game_availability (
    tenant_id,
    brand_id,
    coalesce(market_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(website_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(agent_id, ''),
    coalesce(player_account_id, '00000000-0000-0000-0000-000000000000'::uuid),
    game_code,
    version
  );

create index idx_platform_game_availability_player
  on platform.game_availability(player_account_id)
  where player_account_id is not null;

create or replace function platform.validate_ticket_availability_scope()
returns trigger
language plpgsql
as $$
declare
  v_account public.accounts%rowtype;
begin
  if new.player_account_id is not null then
    select * into v_account
    from public.accounts
    where id = new.player_account_id
      and governance_managed
      and account_type = 'PLAYER';
    if not found
       or row(v_account.canonical_tenant_id, v_account.canonical_brand_id)
          is distinct from row(new.tenant_id, new.brand_id)
       or (new.market_id is not null
           and v_account.canonical_market_id <> new.market_id) then
      raise exception 'player availability restriction must remain in canonical account scope';
    end if;
  end if;

  if new.agent_id is not null then
    begin
      select * into v_account
      from public.accounts
      where id = new.agent_id::uuid
        and governance_managed
        and account_type in ('MASTER_AGENT', 'AGENT');
    exception when invalid_text_representation then
      raise exception 'agent availability scope must reference a canonical account UUID';
    end;
    if not found
       or row(v_account.canonical_tenant_id, v_account.canonical_brand_id)
          is distinct from row(new.tenant_id, new.brand_id)
       or (new.market_id is not null
           and v_account.canonical_market_id <> new.market_id) then
      raise exception 'agent availability restriction must remain in canonical account scope';
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_validate_ticket_availability_scope
before insert on platform.game_availability
for each row execute function platform.validate_ticket_availability_scope();

create or replace function ticket_authority.lock_availability_configuration()
returns trigger
language plpgsql
as $$
declare
  v_availability platform.game_availability%rowtype;
begin
  if tg_table_schema = 'platform' and tg_table_name = 'game_availability' then
    v_availability := new;
  elsif new.resource = 'game-availability' then
    select * into v_availability
    from platform.game_availability
    where id = new.record_id;
  else
    return new;
  end if;

  if v_availability.id is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      'ticket-availability:' || v_availability.tenant_id::text || ':' ||
      v_availability.brand_id::text || ':' || v_availability.game_code,
      0
    ));
  end if;
  return new;
end;
$$;

create trigger trg_lock_ticket_availability_insert
before insert on platform.game_availability
for each row execute function ticket_authority.lock_availability_configuration();

create trigger trg_lock_ticket_availability_lifecycle
before insert on platform.platform_lifecycle_events
for each row execute function ticket_authority.lock_availability_configuration();

create table ticket_authority.acceptance_requests (
  idempotency_key text primary key,
  canonical_intent_hash text not null check (canonical_intent_hash like 'sha256:%'),
  ticket_id uuid not null unique references ticket_authority.tickets(ticket_id),
  created_at timestamptz not null default now()
);

create table ticket_authority.availability_decisions (
  decision_id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null unique references ticket_authority.tickets(ticket_id),
  selected_availability_id uuid not null references platform.game_availability(id),
  applicable_availability_ids jsonb not null,
  effective_min_wager numeric(18, 2),
  effective_max_wager numeric(18, 2),
  decision_hash text not null unique check (decision_hash like 'sha256:%'),
  decided_at timestamptz not null
);

create trigger trg_acceptance_requests_update_guard
before update or delete on ticket_authority.acceptance_requests
for each row execute function ticket_authority.prevent_evidence_mutation();

create trigger trg_availability_decisions_update_guard
before update or delete on ticket_authority.availability_decisions
for each row execute function ticket_authority.prevent_evidence_mutation();

create or replace function ticket_authority.resolve_effective_availability(
  p_tenant_id uuid,
  p_brand_id uuid,
  p_market_id uuid,
  p_website_id uuid,
  p_agent_id uuid,
  p_master_agent_id uuid,
  p_player_account_id uuid,
  p_game_code text,
  p_as_of timestamptz
)
returns table(
  availability_id uuid,
  availability_version text,
  availability_hash text,
  effective_min_wager numeric(18, 2),
  effective_max_wager numeric(18, 2),
  applicable_availability_ids jsonb,
  decision_hash text,
  is_available boolean,
  effective_status text
)
language plpgsql
as $$
declare
  v_denied boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'ticket-availability:' || p_tenant_id::text || ':' ||
    p_brand_id::text || ':' || lower(btrim(p_game_code)),
    0
  ));

  perform 1
  from platform.game_availability candidate
  where candidate.tenant_id = p_tenant_id
    and candidate.brand_id = p_brand_id
    and candidate.game_code = lower(btrim(p_game_code))
    and candidate.effective_from <= p_as_of
    and (candidate.effective_to is null or candidate.effective_to > p_as_of)
    and (candidate.market_id is null or candidate.market_id = p_market_id)
    and (candidate.website_id is null or candidate.website_id = p_website_id)
    and (candidate.agent_id is null or candidate.agent_id in (
      coalesce(p_agent_id::text, ''), coalesce(p_master_agent_id::text, '')
    ))
    and (candidate.player_account_id is null
      or candidate.player_account_id = p_player_account_id)
  order by candidate.id
  for share;

  with candidates as (
    select candidate.*,
      coalesce(lifecycle.to_status, candidate.status) as effective_status,
      case
        when candidate.player_account_id is not null then 7
        when candidate.agent_id = p_agent_id::text then 6
        when candidate.agent_id = p_master_agent_id::text then 5
        when candidate.website_id is not null then 4
        when candidate.market_id is not null then 3
        else 2
      end as specificity
    from platform.game_availability candidate
    left join lateral (
      select event.to_status
      from platform.platform_lifecycle_events event
      where event.resource = 'game-availability'
        and event.record_id = candidate.id
      order by event.created_at desc, event.event_id desc
      limit 1
    ) lifecycle on true
    where candidate.tenant_id = p_tenant_id
      and candidate.brand_id = p_brand_id
      and candidate.game_code = lower(btrim(p_game_code))
      and coalesce(lifecycle.to_status, candidate.status) in ('Active', 'Suspended', 'Retired')
      and candidate.effective_from <= p_as_of
      and (candidate.effective_to is null or candidate.effective_to > p_as_of)
      and (candidate.market_id is null or candidate.market_id = p_market_id)
      and (candidate.website_id is null or candidate.website_id = p_website_id)
      and (candidate.agent_id is null or candidate.agent_id in (
        coalesce(p_agent_id::text, ''), coalesce(p_master_agent_id::text, '')
      ))
      and (candidate.player_account_id is null
        or candidate.player_account_id = p_player_account_id)
  )
  select coalesce(bool_or(candidates.effective_status <> 'Active'), false)
  into v_denied
  from candidates;

  return query
  with candidates as (
    select candidate.*,
      coalesce(lifecycle.to_status, candidate.status) as effective_status,
      case
        when candidate.player_account_id is not null then 7
        when candidate.agent_id = p_agent_id::text then 6
        when candidate.agent_id = p_master_agent_id::text then 5
        when candidate.website_id is not null then 4
        when candidate.market_id is not null then 3
        else 2
      end as specificity
    from platform.game_availability candidate
    left join lateral (
      select event.to_status
      from platform.platform_lifecycle_events event
      where event.resource = 'game-availability'
        and event.record_id = candidate.id
      order by event.created_at desc, event.event_id desc
      limit 1
    ) lifecycle on true
    where candidate.tenant_id = p_tenant_id
      and candidate.brand_id = p_brand_id
      and candidate.game_code = lower(btrim(p_game_code))
      and coalesce(lifecycle.to_status, candidate.status) in ('Active', 'Suspended', 'Retired')
      and candidate.effective_from <= p_as_of
      and (candidate.effective_to is null or candidate.effective_to > p_as_of)
      and (candidate.market_id is null or candidate.market_id = p_market_id)
      and (candidate.website_id is null or candidate.website_id = p_website_id)
      and (candidate.agent_id is null or candidate.agent_id in (
        coalesce(p_agent_id::text, ''), coalesce(p_master_agent_id::text, '')
      ))
      and (candidate.player_account_id is null
        or candidate.player_account_id = p_player_account_id)
  ), aggregate_values as (
    select
      max(min_wager_override) filter (where min_wager_override is not null) as min_wager,
      min(max_wager_override) filter (where max_wager_override is not null) as max_wager,
      jsonb_agg(id order by specificity, id) as candidate_ids
    from candidates
    where candidates.effective_status = 'Active'
  ), selected as (
    select * from candidates
    order by specificity desc, effective_from desc, created_at desc, id
    limit 1
  )
  select
    selected.id,
    selected.version,
    selected.content_hash,
    aggregate_values.min_wager,
    aggregate_values.max_wager,
    aggregate_values.candidate_ids,
    ticket_authority.hash_json(jsonb_build_object(
      'selectedAvailabilityId', selected.id,
      'selectedVersion', selected.version,
      'selectedHash', selected.content_hash,
      'applicableAvailabilityIds', aggregate_values.candidate_ids,
      'effectiveMinWager', aggregate_values.min_wager,
      'effectiveMaxWager', aggregate_values.max_wager,
      'decidedAt', p_as_of,
      'isAvailable', not v_denied and selected.effective_status = 'Active'
    )),
    not v_denied and selected.effective_status = 'Active',
    case when v_denied then 'Suspended' else selected.effective_status end
  from selected
  cross join aggregate_values;
end;
$$;

create or replace function platform.resolve_game_availability(
  p_tenant_id uuid,
  p_brand_id uuid,
  p_market_id uuid default null,
  p_website_id uuid default null,
  p_agent_id text default null,
  p_as_of timestamptz default now()
)
returns table (
  availability_id uuid,
  tenant_id uuid,
  brand_id uuid,
  market_id uuid,
  website_id uuid,
  agent_id text,
  game_id text,
  game_code text,
  game_manifest_reference text,
  status text,
  is_available boolean,
  specificity_rank integer,
  min_wager_override numeric(18, 2),
  max_wager_override numeric(18, 2),
  language_override text,
  currency_override text,
  timezone_override text,
  content_hash text
)
language sql
volatile
as $$
  with game_codes as (
    select distinct candidate.game_code
    from platform.game_availability candidate
    where candidate.tenant_id = p_tenant_id
      and candidate.brand_id = p_brand_id
      and candidate.effective_from <= p_as_of
      and (candidate.effective_to is null or candidate.effective_to > p_as_of)
      and (candidate.market_id is null or candidate.market_id = p_market_id)
      and (candidate.website_id is null or candidate.website_id = p_website_id)
  ), decisions as (
    select game_codes.game_code, decision.*
    from game_codes
    cross join lateral ticket_authority.resolve_effective_availability(
      p_tenant_id,
      p_brand_id,
      p_market_id,
      p_website_id,
      case when coalesce(p_agent_id, '') ~* '^[0-9a-f-]{36}$'
        then p_agent_id::uuid else null end,
      null,
      null,
      game_codes.game_code,
      p_as_of
    ) decision
  )
  select
    selected.id,
    selected.tenant_id,
    selected.brand_id,
    selected.market_id,
    selected.website_id,
    selected.agent_id,
    selected.game_id,
    selected.game_code,
    selected.game_manifest_reference,
    decisions.effective_status,
    decisions.is_available,
    case
      when selected.player_account_id is not null then 7
      when selected.agent_id is not null then 6
      when selected.website_id is not null then 4
      when selected.market_id is not null then 3
      else 2
    end,
    decisions.effective_min_wager,
    decisions.effective_max_wager,
    selected.language_override,
    selected.currency_override,
    selected.timezone_override,
    selected.content_hash
  from decisions
  join platform.game_availability selected
    on selected.id = decisions.availability_id
  order by selected.game_code;
$$;

alter function ticket_authority.accept_ticket(
  uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,
  text,text,jsonb,text,text,text,text,text
) rename to persist_authorized_ticket;

revoke all on function ticket_authority.persist_authorized_ticket(
  uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,
  text,text,jsonb,text,text,text,text,text
) from public;

do $$
declare
  v_identity regprocedure :=
    'ticket_authority.persist_authorized_ticket(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,jsonb,text,text,text,text,text)'::regprocedure;
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(v_identity) into v_definition;
  v_updated := replace(
    v_definition,
    E'  where id = p_game_availability_id\n    and tenant_id = v_account.canonical_tenant_id\n    and brand_id = v_account.canonical_brand_id\n    and market_id = v_account.canonical_market_id\n    and status = ''Active''\n    and effective_from <= now()\n    and (effective_to is null or effective_to > now());',
    E'  where id = p_game_availability_id\n    and tenant_id = v_account.canonical_tenant_id\n    and brand_id = v_account.canonical_brand_id;'
  );
  if v_updated = v_definition then
    raise exception 'Canonical availability wrapper could not retire the legacy market-only check.';
  end if;
  v_definition := v_updated;
  v_updated := replace(
    v_definition,
    E'  if v_draw.status <> ''SalesOpen''\n     or now() < v_draw.sales_open_at\n     or now() >= v_draw.sales_close_at then\n    raise exception ''draw does not permit ticket acceptance'';\n  end if;',
    E'  -- The public acceptance authority already holds the authoritative draw fence.'
  );
  if v_updated = v_definition then
    raise exception 'Canonical draw fence could not retire the duplicate close decision.';
  end if;
  execute v_updated;
end;
$$;

create or replace function ticket_authority.accept_ticket(
  p_player_account_id uuid,
  p_player_profile_id uuid,
  p_requested_funding_instrument text,
  p_requested_wallet_id uuid,
  p_product_id uuid,
  p_manifest_id uuid,
  p_paytable_definition_id uuid,
  p_draw_id uuid,
  p_hostname text,
  p_external_ticket_id text,
  p_currency text,
  p_items jsonb,
  p_idempotency_key text,
  p_correlation_id text,
  p_causation_id text,
  p_actor_reference text,
  p_sales_channel text
)
returns jsonb
language plpgsql
as $$
declare
  v_account public.accounts%rowtype;
  v_product game_engine.game_definitions%rowtype;
  v_draw game_engine.draw_schedules%rowtype;
  v_existing_request ticket_authority.acceptance_requests%rowtype;
  v_availability record;
  v_funding record;
  v_result jsonb;
  v_intent_hash text;
  v_hostname text := nullif(lower(split_part(btrim(coalesce(p_hostname, '')), ':', 1)), '');
  v_website_id uuid;
  v_domain_id uuid;
  v_agent_id uuid;
  v_master_agent_id uuid;
  v_total bigint := 0;
  v_item jsonb;
  v_decided_at timestamptz;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'ticket idempotency key is required';
  end if;

  v_intent_hash := ticket_authority.hash_json(jsonb_build_object(
    'playerAccountId', p_player_account_id,
    'playerProfileId', p_player_profile_id,
    'requestedFundingInstrument', upper(nullif(btrim(coalesce(p_requested_funding_instrument, '')), '')),
    'requestedWalletId', p_requested_wallet_id,
    'productId', p_product_id,
    'manifestId', p_manifest_id,
    'paytableDefinitionId', p_paytable_definition_id,
    'drawId', p_draw_id,
    'hostname', v_hostname,
    'externalTicketId', nullif(btrim(coalesce(p_external_ticket_id, '')), ''),
    'currency', upper(coalesce(p_currency, '')),
    'items', p_items,
    'salesChannel', coalesce(nullif(btrim(p_sales_channel), ''), 'API')
  ));

  perform pg_advisory_xact_lock(hashtextextended('ticket-acceptance:' || btrim(p_idempotency_key), 0));
  select * into v_existing_request
  from ticket_authority.acceptance_requests
  where idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_existing_request.canonical_intent_hash <> v_intent_hash then
      raise exception 'ticket idempotency key conflicts with a different canonical request';
    end if;
    select jsonb_build_object(
      'accepted', true,
      'duplicate', true,
      'ticketId', ticket.ticket_id,
      'reservationId', ticket.reservation_id,
      'status', ticket.status,
      'canonicalRequestHash', ticket.canonical_request_hash,
      'acceptanceHash', ticket.acceptance_hash
    ) into v_result
    from ticket_authority.tickets ticket
    where ticket.ticket_id = v_existing_request.ticket_id;
    return v_result;
  end if;

  select * into v_account
  from public.accounts
  where id = p_player_account_id
    and governance_managed
    and account_type = 'PLAYER'
    and status = 'ACTIVE';
  if not found then
    raise exception 'active governed player account and canonical scope are required';
  end if;

  with recursive hierarchy as (
    select id, parent_account_id, account_type, status, 0 depth
    from public.accounts where id = p_player_account_id
    union all
    select parent.id, parent.parent_account_id, parent.account_type, parent.status,
      hierarchy.depth + 1
    from public.accounts parent
    join hierarchy on hierarchy.parent_account_id = parent.id
    where hierarchy.depth < 8
  )
  select
    (array_agg(id order by depth)
      filter (where account_type = 'AGENT' and status = 'ACTIVE'))[1],
    (array_agg(id order by depth)
      filter (where account_type = 'MASTER_AGENT' and status = 'ACTIVE'))[1]
  into v_agent_id, v_master_agent_id
  from hierarchy;

  if v_hostname is not null then
    select resolved.website_id, resolved.domain_id
    into v_website_id, v_domain_id
    from platform.active_host_resolutions resolved
    where resolved.hostname = v_hostname
      and resolved.tenant_id = v_account.canonical_tenant_id
      and resolved.brand_id = v_account.canonical_brand_id
      and (resolved.market_id is null
        or resolved.market_id = v_account.canonical_market_id)
      and not resolved.maintenance_mode
    limit 1;
    if not found then
      raise exception 'active non-maintenance ticket host does not match canonical player scope';
    end if;
  end if;

  select * into v_product
  from game_engine.game_definitions
  where id = p_product_id and active_version_id is not null;
  if not found then
    raise exception 'active canonical game product is unavailable';
  end if;

  v_decided_at := clock_timestamp();
  select * into v_availability
  from ticket_authority.resolve_effective_availability(
    v_account.canonical_tenant_id,
    v_account.canonical_brand_id,
    v_account.canonical_market_id,
    v_website_id,
    v_agent_id,
    v_master_agent_id,
    p_player_account_id,
    v_product.code,
    v_decided_at
  );
  if not found then
    raise exception 'effective game availability is required';
  end if;
  if not v_availability.is_available then
    raise exception 'effective game availability is denied by an applicable scope';
  end if;

  select * into v_draw
  from game_engine.draw_schedules
  where id = p_draw_id and game_definition_id = p_product_id
  for update;
  if not found
     or v_draw.status <> 'SalesOpen'
     or clock_timestamp() < v_draw.sales_open_at
     or clock_timestamp() >= v_draw.sales_close_at then
    raise exception 'draw does not permit ticket acceptance';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'ticket requires at least one wager item';
  end if;
  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_total := v_total + coalesce((v_item->>'stakeMinor')::bigint, 0);
  end loop;
  if v_availability.effective_min_wager is not null
     and v_total < round(v_availability.effective_min_wager * 100)::bigint then
    raise exception 'ticket total stake is below the effective minimum wager';
  end if;
  if v_availability.effective_max_wager is not null
     and v_total > round(v_availability.effective_max_wager * 100)::bigint then
    raise exception 'ticket total stake exceeds the effective maximum wager';
  end if;

  select * into v_funding
  from funding_authority.resolve_funding_instrument(
    p_player_account_id,
    p_requested_funding_instrument,
    p_requested_wallet_id,
    p_currency,
    'TICKET_ACCEPTANCE',
    'ticket-funding:' || btrim(p_idempotency_key),
    p_correlation_id
  );

  v_result := ticket_authority.persist_authorized_ticket(
    p_player_account_id,
    p_player_profile_id,
    v_funding.wallet_id,
    v_availability.availability_id,
    p_product_id,
    p_manifest_id,
    p_paytable_definition_id,
    p_draw_id,
    v_website_id,
    v_domain_id,
    p_external_ticket_id,
    p_currency,
    p_items,
    p_idempotency_key,
    p_correlation_id,
    p_causation_id,
    p_actor_reference,
    p_sales_channel
  );

  insert into ticket_authority.acceptance_requests(
    idempotency_key, canonical_intent_hash, ticket_id
  ) values (
    btrim(p_idempotency_key), v_intent_hash, (v_result->>'ticketId')::uuid
  );

  insert into ticket_authority.availability_decisions(
    ticket_id, selected_availability_id, applicable_availability_ids,
    effective_min_wager, effective_max_wager, decision_hash, decided_at
  ) values (
    (v_result->>'ticketId')::uuid,
    v_availability.availability_id,
    v_availability.applicable_availability_ids,
    v_availability.effective_min_wager,
    v_availability.effective_max_wager,
    v_availability.decision_hash,
    v_decided_at
  );

  return v_result;
end;
$$;

comment on function ticket_authority.accept_ticket(
  uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,text,text,text
) is
  'Sole ticket acceptance authority: derives effective availability, fences draw close, resolves funding, reserves, and persists atomically.';

comment on table ticket_authority.availability_decisions is
  'Immutable effective availability evidence. Applicable parent restrictions are deny-dominant and wager limits are intersected.';

commit;
