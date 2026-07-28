create extension if not exists pgcrypto;
create schema if not exists ticket_authority;

create table ticket_authority.tickets (
  ticket_id uuid primary key,
  external_ticket_id text,
  platform_id uuid not null references platform.platforms(id),
  organization_id uuid not null references platform.organizations(id),
  tenant_id uuid not null references platform.tenants(id),
  brand_id uuid not null references platform.brands(id),
  market_id uuid not null references platform.markets(id),
  website_id uuid references platform.websites(id),
  domain_id uuid references platform.website_domains(id),
  player_account_id uuid not null references public.accounts(id),
  player_profile_id uuid not null references public.player_profiles(id),
  agent_account_id uuid references public.accounts(id),
  master_agent_account_id uuid references public.accounts(id),
  wallet_id uuid not null references public.financial_wallets(id),
  reservation_id uuid not null unique references public.credit_reservations(id),
  product_id uuid not null references game_engine.game_definitions(id),
  product_version_id uuid not null references game_engine.game_definition_versions(id),
  product_version integer not null,
  game_code text not null,
  game_configuration_hash text not null,
  manifest_id uuid not null references game_engine.game_manifests(id),
  manifest_version text not null,
  manifest_hash text not null,
  paytable_definition_id uuid not null references game_engine.paytable_definitions(id),
  paytable_id text not null,
  paytable_version text not null,
  paytable_hash text not null,
  game_availability_id uuid not null references platform.game_availability(id),
  game_availability_version text not null,
  game_availability_hash text not null,
  draw_id uuid not null references game_engine.draw_schedules(id),
  draw_binding_hash text not null,
  status text not null,
  currency text not null,
  total_stake_minor bigint not null,
  acceptance_snapshot jsonb not null,
  canonical_request_hash text not null,
  acceptance_hash text not null,
  idempotency_key text not null unique,
  correlation_id text not null,
  causation_id text,
  actor_reference text not null,
  sales_channel text not null,
  accepted_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint ck_ticket_status check (
    status in (
      'ACCEPTED',
      'AWAITING_DRAW',
      'CLOSED',
      'SETTLEMENT_PENDING',
      'SETTLED',
      'CANCELLED',
      'VOIDED'
    )
  ),
  constraint ck_ticket_currency check (currency ~ '^[A-Z]{3}$'),
  constraint ck_ticket_positive_stake check (total_stake_minor > 0),
  constraint ck_ticket_hashes check (
    canonical_request_hash ~ '^sha256:'
    and acceptance_hash ~ '^sha256:'
    and draw_binding_hash ~ '^sha256:'
  )
);

create table ticket_authority.ticket_items (
  ticket_item_id uuid primary key,
  ticket_id uuid not null references ticket_authority.tickets(ticket_id),
  item_index integer not null,
  wager_type text not null,
  wager_version text not null,
  normalized_selections jsonb not null,
  stake_minor bigint not null,
  item_hash text not null,
  created_at timestamptz not null default now(),
  constraint ux_ticket_item_index unique (ticket_id, item_index),
  constraint ck_ticket_item_stake check (stake_minor > 0),
  constraint ck_ticket_item_hash check (item_hash ~ '^sha256:')
);

create table ticket_authority.ticket_lifecycle_events (
  event_id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references ticket_authority.tickets(ticket_id),
  previous_status text,
  status text not null,
  reason_code text not null,
  actor_reference text not null,
  correlation_id text not null,
  causation_id text,
  evidence jsonb not null default '{}'::jsonb,
  canonical_event_hash text not null,
  created_at timestamptz not null default now(),
  constraint ck_ticket_lifecycle_status check (
    status in (
      'SUBMITTED',
      'VALIDATING',
      'ACCEPTED',
      'AWAITING_DRAW',
      'CLOSED',
      'SETTLEMENT_PENDING',
      'SETTLED',
      'REJECTED',
      'CANCELLED',
      'VOIDED',
      'REVERSED',
      'RESETTLED'
    )
  ),
  constraint ck_ticket_lifecycle_hash check (canonical_event_hash ~ '^sha256:')
);

create table ticket_authority.ticket_cancellation_requests (
  cancellation_id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references ticket_authority.tickets(ticket_id),
  idempotency_key text not null unique,
  reason_code text not null,
  requested_by text not null,
  reservation_release_id uuid,
  canonical_request_hash text not null,
  created_at timestamptz not null default now(),
  constraint ck_ticket_cancellation_hash check (canonical_request_hash ~ '^sha256:')
);

create table ticket_authority.ticket_correlations (
  correlation_event_id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references ticket_authority.tickets(ticket_id),
  ticket_item_id uuid references ticket_authority.ticket_items(ticket_item_id),
  correlation_type text not null,
  source_id text not null,
  source_hash text not null,
  operation_kind text not null,
  evidence jsonb not null default '{}'::jsonb,
  correlation_id text not null,
  canonical_correlation_hash text not null,
  created_at timestamptz not null default now(),
  constraint ux_ticket_correlation_source unique (
    ticket_id,
    correlation_type,
    source_id,
    operation_kind
  ),
  constraint ck_ticket_correlation_type check (
    correlation_type in (
      'OUTCOME',
      'SETTLEMENT',
      'LEDGER_INSTRUCTION',
      'LEDGER_ENTRY',
      'WALLET_OPERATION',
      'REVERSAL',
      'RESETTLEMENT',
      'DRAW_VOID'
    )
  ),
  constraint ck_ticket_correlation_hash check (
    source_hash ~ '^sha256:' and canonical_correlation_hash ~ '^sha256:'
  )
);

create table ticket_authority.ticket_recovery_events (
  recovery_event_id uuid primary key default gen_random_uuid(),
  ticket_id uuid references ticket_authority.tickets(ticket_id),
  recovery_type text not null,
  status text not null,
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  requested_by text not null,
  canonical_evidence_hash text not null,
  created_at timestamptz not null default now(),
  constraint ck_ticket_recovery_status check (
    status in ('DETECTED', 'RECOVERED', 'FAILED_CLOSED')
  ),
  constraint ck_ticket_recovery_hash check (canonical_evidence_hash ~ '^sha256:')
);

create index idx_tickets_scope_status
  on ticket_authority.tickets (tenant_id, brand_id, market_id, status, accepted_at desc);
create index idx_tickets_player
  on ticket_authority.tickets (player_account_id, accepted_at desc);
create index idx_tickets_draw
  on ticket_authority.tickets (draw_id, status, accepted_at);
create index idx_ticket_lifecycle_history
  on ticket_authority.ticket_lifecycle_events (ticket_id, created_at, event_id);
create index idx_ticket_correlations_lookup
  on ticket_authority.ticket_correlations (ticket_id, correlation_type, created_at);
create index idx_ticket_recovery_open
  on ticket_authority.ticket_recovery_events (status, created_at);

create or replace function ticket_authority.prevent_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'canonical ticket evidence is append-only';
end;
$$;

create trigger ticket_items_update_guard
before update on ticket_authority.ticket_items
for each row execute function ticket_authority.prevent_evidence_mutation();
create trigger ticket_items_delete_guard
before delete on ticket_authority.ticket_items
for each row execute function ticket_authority.prevent_evidence_mutation();
create trigger ticket_lifecycle_update_guard
before update on ticket_authority.ticket_lifecycle_events
for each row execute function ticket_authority.prevent_evidence_mutation();
create trigger ticket_lifecycle_delete_guard
before delete on ticket_authority.ticket_lifecycle_events
for each row execute function ticket_authority.prevent_evidence_mutation();
create trigger ticket_cancellation_update_guard
before update on ticket_authority.ticket_cancellation_requests
for each row execute function ticket_authority.prevent_evidence_mutation();
create trigger ticket_cancellation_delete_guard
before delete on ticket_authority.ticket_cancellation_requests
for each row execute function ticket_authority.prevent_evidence_mutation();
create trigger ticket_correlations_update_guard
before update on ticket_authority.ticket_correlations
for each row execute function ticket_authority.prevent_evidence_mutation();
create trigger ticket_correlations_delete_guard
before delete on ticket_authority.ticket_correlations
for each row execute function ticket_authority.prevent_evidence_mutation();
create trigger ticket_recovery_update_guard
before update on ticket_authority.ticket_recovery_events
for each row execute function ticket_authority.prevent_evidence_mutation();
create trigger ticket_recovery_delete_guard
before delete on ticket_authority.ticket_recovery_events
for each row execute function ticket_authority.prevent_evidence_mutation();

create or replace function ticket_authority.guard_ticket_update()
returns trigger
language plpgsql
as $$
begin
  if row(
    new.ticket_id,
    new.platform_id,
    new.organization_id,
    new.tenant_id,
    new.brand_id,
    new.market_id,
    new.website_id,
    new.domain_id,
    new.player_account_id,
    new.player_profile_id,
    new.agent_account_id,
    new.master_agent_account_id,
    new.wallet_id,
    new.reservation_id,
    new.product_id,
    new.product_version_id,
    new.product_version,
    new.game_code,
    new.game_configuration_hash,
    new.manifest_id,
    new.manifest_version,
    new.manifest_hash,
    new.paytable_definition_id,
    new.paytable_id,
    new.paytable_version,
    new.paytable_hash,
    new.game_availability_id,
    new.game_availability_version,
    new.game_availability_hash,
    new.draw_id,
    new.draw_binding_hash,
    new.currency,
    new.total_stake_minor,
    new.acceptance_snapshot,
    new.canonical_request_hash,
    new.acceptance_hash,
    new.idempotency_key,
    new.correlation_id,
    new.causation_id,
    new.actor_reference,
    new.sales_channel,
    new.accepted_at
  ) is distinct from row(
    old.ticket_id,
    old.platform_id,
    old.organization_id,
    old.tenant_id,
    old.brand_id,
    old.market_id,
    old.website_id,
    old.domain_id,
    old.player_account_id,
    old.player_profile_id,
    old.agent_account_id,
    old.master_agent_account_id,
    old.wallet_id,
    old.reservation_id,
    old.product_id,
    old.product_version_id,
    old.product_version,
    old.game_code,
    old.game_configuration_hash,
    old.manifest_id,
    old.manifest_version,
    old.manifest_hash,
    old.paytable_definition_id,
    old.paytable_id,
    old.paytable_version,
    old.paytable_hash,
    old.game_availability_id,
    old.game_availability_version,
    old.game_availability_hash,
    old.draw_id,
    old.draw_binding_hash,
    old.currency,
    old.total_stake_minor,
    old.acceptance_snapshot,
    old.canonical_request_hash,
    old.acceptance_hash,
    old.idempotency_key,
    old.correlation_id,
    old.causation_id,
    old.actor_reference,
    old.sales_channel,
    old.accepted_at
  ) then
    raise exception 'accepted ticket identity and snapshot are immutable';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger tickets_update_guard
before update on ticket_authority.tickets
for each row execute function ticket_authority.guard_ticket_update();
create trigger tickets_delete_guard
before delete on ticket_authority.tickets
for each row execute function ticket_authority.prevent_evidence_mutation();

create or replace function ticket_authority.hash_json(payload jsonb)
returns text
language sql
immutable
strict
as $$
  select 'sha256:' || encode(digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex');
$$;

create or replace function ticket_authority.append_lifecycle_event(
  p_ticket_id uuid,
  p_previous_status text,
  p_status text,
  p_reason_code text,
  p_actor_reference text,
  p_correlation_id text,
  p_causation_id text,
  p_evidence jsonb
)
returns uuid
language plpgsql
as $$
declare
  v_event_id uuid := gen_random_uuid();
  v_payload jsonb;
begin
  v_payload := jsonb_build_object(
    'eventId', v_event_id,
    'ticketId', p_ticket_id,
    'previousStatus', p_previous_status,
    'status', p_status,
    'reasonCode', p_reason_code,
    'actorReference', p_actor_reference,
    'correlationId', p_correlation_id,
    'causationId', p_causation_id,
    'evidence', coalesce(p_evidence, '{}'::jsonb)
  );
  insert into ticket_authority.ticket_lifecycle_events (
    event_id,
    ticket_id,
    previous_status,
    status,
    reason_code,
    actor_reference,
    correlation_id,
    causation_id,
    evidence,
    canonical_event_hash
  )
  values (
    v_event_id,
    p_ticket_id,
    p_previous_status,
    p_status,
    p_reason_code,
    p_actor_reference,
    p_correlation_id,
    p_causation_id,
    coalesce(p_evidence, '{}'::jsonb),
    ticket_authority.hash_json(v_payload)
  );
  return v_event_id;
end;
$$;

create or replace function ticket_authority.accept_ticket(
  p_player_account_id uuid,
  p_player_profile_id uuid,
  p_wallet_id uuid,
  p_game_availability_id uuid,
  p_product_id uuid,
  p_manifest_id uuid,
  p_paytable_definition_id uuid,
  p_draw_id uuid,
  p_website_id uuid,
  p_domain_id uuid,
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
  v_account record;
  v_profile public.player_profiles%rowtype;
  v_availability platform.game_availability%rowtype;
  v_product game_engine.game_definitions%rowtype;
  v_product_version game_engine.game_definition_versions%rowtype;
  v_manifest game_engine.game_manifests%rowtype;
  v_paytable game_engine.paytable_definitions%rowtype;
  v_draw game_engine.draw_schedules%rowtype;
  v_wallet public.financial_wallets%rowtype;
  v_existing ticket_authority.tickets%rowtype;
  v_ticket_id uuid := gen_random_uuid();
  v_reservation jsonb;
  v_item jsonb;
  v_index integer := 0;
  v_total bigint := 0;
  v_request_payload jsonb;
  v_request_hash text;
  v_draw_hash text;
  v_snapshot jsonb;
  v_acceptance_hash text;
  v_agent_id uuid;
  v_master_agent_id uuid;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'ticket idempotency key is required';
  end if;
  if p_correlation_id is null or btrim(p_correlation_id) = '' then
    raise exception 'ticket correlation id is required';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'ticket requires at least one wager item';
  end if;
  if upper(coalesce(p_currency, '')) !~ '^[A-Z]{3}$' then
    raise exception 'ticket currency is invalid';
  end if;

  v_request_payload := jsonb_build_object(
    'playerAccountId', p_player_account_id,
    'playerProfileId', p_player_profile_id,
    'walletId', p_wallet_id,
    'gameAvailabilityId', p_game_availability_id,
    'productId', p_product_id,
    'manifestId', p_manifest_id,
    'paytableDefinitionId', p_paytable_definition_id,
    'drawId', p_draw_id,
    'websiteId', p_website_id,
    'domainId', p_domain_id,
    'externalTicketId', nullif(btrim(coalesce(p_external_ticket_id, '')), ''),
    'currency', upper(p_currency),
    'items', p_items,
    'salesChannel', coalesce(nullif(btrim(p_sales_channel), ''), 'API')
  );
  v_request_hash := ticket_authority.hash_json(v_request_payload);

  perform pg_advisory_xact_lock(hashtextextended(btrim(p_idempotency_key), 0));
  select * into v_existing
  from ticket_authority.tickets
  where idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_existing.canonical_request_hash <> v_request_hash then
      raise exception 'ticket idempotency key conflicts with a different canonical request';
    end if;
    return jsonb_build_object(
      'accepted', true,
      'duplicate', true,
      'ticketId', v_existing.ticket_id,
      'reservationId', v_existing.reservation_id,
      'status', v_existing.status,
      'canonicalRequestHash', v_existing.canonical_request_hash,
      'acceptanceHash', v_existing.acceptance_hash
    );
  end if;

  select
    account.*,
    platform.id as platform_id,
    organization.id as organization_id,
    market.currency as market_currency
  into v_account
  from public.accounts account
  join platform.markets market
    on market.id = account.canonical_market_id
   and market.brand_id = account.canonical_brand_id
  join platform.brands brand
    on brand.id = account.canonical_brand_id
   and brand.tenant_id = account.canonical_tenant_id
  join platform.tenants tenant
    on tenant.id = account.canonical_tenant_id
  join platform.organizations organization
    on organization.id = tenant.organization_id
  join platform.platforms platform
    on platform.id = organization.platform_id
  where account.id = p_player_account_id
    and account.governance_managed
    and account.account_type = 'PLAYER'
    and account.status = 'ACTIVE'
    and market.status = 'Active'
    and brand.status = 'Active'
    and tenant.status = 'Active'
    and organization.status = 'Active'
    and platform.status = 'Active';
  if not found then
    raise exception 'active governed player account and canonical scope are required';
  end if;

  select * into v_profile
  from public.player_profiles
  where id = p_player_profile_id
    and account_id = p_player_account_id
    and status = 'ACTIVE';
  if not found then
    raise exception 'active player profile does not match player account';
  end if;

  with recursive hierarchy as (
    select id, parent_account_id, account_type, status, canonical_tenant_id,
      canonical_brand_id, canonical_market_id, 0 as depth
    from public.accounts where id = p_player_account_id
    union all
    select parent.id, parent.parent_account_id, parent.account_type, parent.status,
      parent.canonical_tenant_id, parent.canonical_brand_id,
      parent.canonical_market_id, hierarchy.depth + 1
    from public.accounts parent
    join hierarchy on hierarchy.parent_account_id = parent.id
    where hierarchy.depth < 8
  )
  select
    max(id) filter (where account_type = 'AGENT'),
    max(id) filter (where account_type = 'MASTER_AGENT')
  into v_agent_id, v_master_agent_id
  from hierarchy
  where status = 'ACTIVE'
    and canonical_tenant_id = v_account.canonical_tenant_id
    and canonical_brand_id = v_account.canonical_brand_id
    and canonical_market_id = v_account.canonical_market_id;

  if v_account.parent_account_id is not null
     and v_agent_id is null and v_master_agent_id is null then
    raise exception 'player agent hierarchy is invalid or inactive';
  end if;

  select * into v_availability
  from platform.game_availability
  where id = p_game_availability_id
    and tenant_id = v_account.canonical_tenant_id
    and brand_id = v_account.canonical_brand_id
    and market_id = v_account.canonical_market_id
    and status = 'Active'
    and effective_from <= now()
    and (effective_to is null or effective_to > now());
  if not found then
    raise exception 'active market game availability is required';
  end if;

  if p_website_id is not null then
    perform 1 from platform.websites
    where id = p_website_id
      and tenant_id = v_account.canonical_tenant_id
      and brand_id = v_account.canonical_brand_id
      and market_id = v_account.canonical_market_id
      and status = 'Active'
      and not maintenance_mode;
    if not found then
      raise exception 'active website does not match ticket scope';
    end if;
  end if;
  if p_domain_id is not null then
    if p_website_id is null then
      raise exception 'ticket domain requires website context';
    end if;
    perform 1 from platform.website_domains
    where id = p_domain_id and website_id = p_website_id and status = 'Active';
    if not found then
      raise exception 'active domain does not match ticket website';
    end if;
  end if;

  select * into v_product
  from game_engine.game_definitions
  where id = p_product_id and code = v_availability.game_code;
  if not found or v_product.active_version_id is null then
    raise exception 'active canonical game product is unavailable';
  end if;
  select * into v_product_version
  from game_engine.game_definition_versions
  where id = v_product.active_version_id
    and game_definition_id = v_product.id
    and effective_from <= now()
    and (effective_to is null or effective_to > now());
  if not found then
    raise exception 'active canonical game product version is unavailable';
  end if;

  select * into v_manifest
  from game_engine.game_manifests
  where id = p_manifest_id
    and game_code = v_product.code
    and lifecycle_state = 'Active'
    and effective_from <= now()
    and (effective_to is null or effective_to > now());
  if not found then
    raise exception 'active immutable game manifest is unavailable';
  end if;
  if nullif(v_availability.game_manifest_reference, '') is not null
     and v_availability.game_manifest_reference not in (
       v_manifest.id::text,
       v_manifest.game_code || ':' || v_manifest.semantic_version,
       v_manifest.content_hash
     ) then
    raise exception 'game availability manifest reference does not match requested manifest';
  end if;

  select * into v_paytable
  from game_engine.paytable_definitions
  where id = p_paytable_definition_id
    and lifecycle_state = 'Active';
  if not found then
    raise exception 'active immutable paytable is unavailable';
  end if;
  if not (
    v_manifest.paytable_references @>
      jsonb_build_array(jsonb_build_object(
        'paytableId', v_paytable.paytable_id,
        'version', v_paytable.version
      ))
  ) then
    raise exception 'paytable is not bound to the game manifest';
  end if;

  select * into v_draw
  from game_engine.draw_schedules
  where id = p_draw_id and game_definition_id = v_product.id;
  if not found then
    raise exception 'canonical draw was not found for the selected product';
  end if;
  if v_draw.status <> 'SalesOpen'
     or now() < v_draw.sales_open_at
     or now() >= v_draw.sales_close_at then
    raise exception 'draw does not permit ticket acceptance';
  end if;

  if upper(p_currency) <> upper(v_account.market_currency) then
    raise exception 'ticket currency does not match canonical market currency';
  end if;
  select * into v_wallet from public.financial_wallets
  where id = p_wallet_id
    and account_id = p_player_account_id
    and wallet_type = 'CREDIT'
    and currency_code = upper(p_currency)
    and status = 'ACTIVE';
  if not found then
    raise exception 'active player credit wallet is required';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if coalesce(v_item->>'wagerType', '') = ''
       or coalesce(v_item->>'wagerVersion', '') = ''
       or jsonb_typeof(v_item->'selections') not in ('array', 'object')
       or coalesce((v_item->>'stakeMinor')::bigint, 0) <= 0 then
      raise exception 'ticket wager item is invalid';
    end if;
    if not (
      v_manifest.wager_schemas @>
        jsonb_build_array(jsonb_build_object(
          'wagerType', v_item->>'wagerType',
          'version', v_item->>'wagerVersion'
        ))
    ) then
      raise exception 'wager type/version is not bound to the game manifest';
    end if;
    v_total := v_total + (v_item->>'stakeMinor')::bigint;
  end loop;
  if v_total <= 0 then
    raise exception 'ticket total stake must be positive';
  end if;

  v_draw_hash := ticket_authority.hash_json(jsonb_build_object(
    'drawId', v_draw.id,
    'gameDefinitionId', v_draw.game_definition_id,
    'salesOpenAt', v_draw.sales_open_at,
    'salesCloseAt', v_draw.sales_close_at,
    'drawAt', v_draw.draw_at
  ));

  v_reservation := credit_wallet_service.reserve_wallet(
    v_ticket_id,
    p_wallet_id,
    v_account.canonical_tenant_id,
    v_account.canonical_brand_id,
    p_player_account_id,
    'CREDIT',
    v_ticket_id::text,
    v_total,
    upper(p_currency),
    'ticket-reservation:' || btrim(p_idempotency_key),
    p_correlation_id,
    jsonb_build_object(
      'ticketAuthority', true,
      'canonicalRequestHash', v_request_hash,
      'drawId', p_draw_id
    )
  );

  v_snapshot := v_request_payload || jsonb_build_object(
    'ticketId', v_ticket_id,
    'platformId', v_account.platform_id,
    'organizationId', v_account.organization_id,
    'tenantId', v_account.canonical_tenant_id,
    'brandId', v_account.canonical_brand_id,
    'marketId', v_account.canonical_market_id,
    'agentAccountId', v_agent_id,
    'masterAgentAccountId', v_master_agent_id,
    'productVersionId', v_product_version.id,
    'productVersion', v_product_version.version_number,
    'gameConfigurationHash', v_product_version.definition_hash,
    'manifestVersion', v_manifest.semantic_version,
    'manifestHash', v_manifest.content_hash,
    'paytableId', v_paytable.paytable_id,
    'paytableVersion', v_paytable.version,
    'paytableHash', v_paytable.content_hash,
    'gameAvailabilityVersion', v_availability.version,
    'gameAvailabilityHash', v_availability.content_hash,
    'drawBindingHash', v_draw_hash,
    'reservationId', v_reservation->>'id',
    'totalStakeMinor', v_total
  );
  v_acceptance_hash := ticket_authority.hash_json(v_snapshot);

  insert into ticket_authority.tickets (
    ticket_id,
    external_ticket_id,
    platform_id,
    organization_id,
    tenant_id,
    brand_id,
    market_id,
    website_id,
    domain_id,
    player_account_id,
    player_profile_id,
    agent_account_id,
    master_agent_account_id,
    wallet_id,
    reservation_id,
    product_id,
    product_version_id,
    product_version,
    game_code,
    game_configuration_hash,
    manifest_id,
    manifest_version,
    manifest_hash,
    paytable_definition_id,
    paytable_id,
    paytable_version,
    paytable_hash,
    game_availability_id,
    game_availability_version,
    game_availability_hash,
    draw_id,
    draw_binding_hash,
    status,
    currency,
    total_stake_minor,
    acceptance_snapshot,
    canonical_request_hash,
    acceptance_hash,
    idempotency_key,
    correlation_id,
    causation_id,
    actor_reference,
    sales_channel,
    accepted_at
  )
  values (
    v_ticket_id,
    nullif(btrim(coalesce(p_external_ticket_id, '')), ''),
    v_account.platform_id,
    v_account.organization_id,
    v_account.canonical_tenant_id,
    v_account.canonical_brand_id,
    v_account.canonical_market_id,
    p_website_id,
    p_domain_id,
    p_player_account_id,
    p_player_profile_id,
    v_agent_id,
    v_master_agent_id,
    p_wallet_id,
    (v_reservation->>'id')::uuid,
    v_product.id,
    v_product_version.id,
    v_product_version.version_number,
    v_product.code,
    v_product_version.definition_hash,
    v_manifest.id,
    v_manifest.semantic_version,
    v_manifest.content_hash,
    v_paytable.id,
    v_paytable.paytable_id,
    v_paytable.version,
    v_paytable.content_hash,
    v_availability.id,
    v_availability.version,
    v_availability.content_hash,
    v_draw.id,
    v_draw_hash,
    'AWAITING_DRAW',
    upper(p_currency),
    v_total,
    v_snapshot,
    v_request_hash,
    v_acceptance_hash,
    btrim(p_idempotency_key),
    p_correlation_id,
    nullif(btrim(coalesce(p_causation_id, '')), ''),
    coalesce(nullif(btrim(p_actor_reference), ''), 'system'),
    coalesce(nullif(btrim(p_sales_channel), ''), 'API'),
    now()
  );

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    insert into ticket_authority.ticket_items (
      ticket_item_id,
      ticket_id,
      item_index,
      wager_type,
      wager_version,
      normalized_selections,
      stake_minor,
      item_hash
    )
    values (
      gen_random_uuid(),
      v_ticket_id,
      v_index,
      v_item->>'wagerType',
      v_item->>'wagerVersion',
      v_item->'selections',
      (v_item->>'stakeMinor')::bigint,
      ticket_authority.hash_json(jsonb_build_object(
        'ticketId', v_ticket_id,
        'itemIndex', v_index,
        'wagerType', v_item->>'wagerType',
        'wagerVersion', v_item->>'wagerVersion',
        'selections', v_item->'selections',
        'stakeMinor', (v_item->>'stakeMinor')::bigint
      ))
    );
    v_index := v_index + 1;
  end loop;

  perform ticket_authority.append_lifecycle_event(
    v_ticket_id,
    null,
    'ACCEPTED',
    'VALIDATION_AND_RESERVATION_SUCCEEDED',
    p_actor_reference,
    p_correlation_id,
    p_causation_id,
    jsonb_build_object('reservationId', v_reservation->>'id')
  );
  perform ticket_authority.append_lifecycle_event(
    v_ticket_id,
    'ACCEPTED',
    'AWAITING_DRAW',
    'CANONICAL_DRAW_BOUND',
    p_actor_reference,
    p_correlation_id,
    p_causation_id,
    jsonb_build_object('drawId', v_draw.id, 'drawBindingHash', v_draw_hash)
  );

  insert into public.outbox_events (
    event_type,
    aggregate_type,
    aggregate_id,
    payload,
    status,
    correlation_id
  )
  values (
    'ticket.accepted',
    'ticket',
    v_ticket_id::text,
    jsonb_build_object(
      'ticketId', v_ticket_id,
      'playerAccountId', p_player_account_id,
      'reservationId', v_reservation->>'id',
      'drawId', v_draw.id,
      'manifestId', v_manifest.id,
      'manifestVersion', v_manifest.semantic_version,
      'paytableId', v_paytable.paytable_id,
      'paytableVersion', v_paytable.version,
      'totalStakeMinor', v_total,
      'currency', upper(p_currency),
      'acceptanceHash', v_acceptance_hash
    ),
    'PENDING',
    p_correlation_id
  );

  return jsonb_build_object(
    'accepted', true,
    'duplicate', false,
    'ticketId', v_ticket_id,
    'reservationId', v_reservation->>'id',
    'status', 'AWAITING_DRAW',
    'canonicalRequestHash', v_request_hash,
    'acceptanceHash', v_acceptance_hash
  );
end;
$$;

create or replace function ticket_authority.cancel_ticket(
  p_ticket_id uuid,
  p_idempotency_key text,
  p_reason_code text,
  p_requested_by text,
  p_correlation_id text
)
returns jsonb
language plpgsql
as $$
declare
  v_ticket ticket_authority.tickets%rowtype;
  v_draw game_engine.draw_schedules%rowtype;
  v_manifest game_engine.game_manifests%rowtype;
  v_reservation public.credit_reservations%rowtype;
  v_existing ticket_authority.ticket_cancellation_requests%rowtype;
  v_release jsonb;
  v_request_hash text;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'cancellation idempotency key is required';
  end if;
  v_request_hash := ticket_authority.hash_json(jsonb_build_object(
    'ticketId', p_ticket_id,
    'reasonCode', p_reason_code
  ));
  perform pg_advisory_xact_lock(hashtextextended('ticket-cancel:' || p_ticket_id::text, 0));

  select * into v_existing from ticket_authority.ticket_cancellation_requests
  where idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_existing.ticket_id <> p_ticket_id
       or v_existing.canonical_request_hash <> v_request_hash then
      raise exception 'cancellation idempotency key conflicts with another request';
    end if;
    return jsonb_build_object(
      'cancelled', true,
      'duplicate', true,
      'ticketId', p_ticket_id,
      'cancellationId', v_existing.cancellation_id
    );
  end if;

  select * into v_ticket from ticket_authority.tickets
  where ticket_id = p_ticket_id for update;
  if not found then raise exception 'ticket not found'; end if;
  if v_ticket.status <> 'AWAITING_DRAW' then
    raise exception 'ticket lifecycle does not permit cancellation';
  end if;
  select * into v_draw from game_engine.draw_schedules where id = v_ticket.draw_id;
  if not found or v_draw.status <> 'SalesOpen' or now() >= v_draw.sales_close_at then
    raise exception 'ticket cancellation cutoff has passed';
  end if;
  select * into v_manifest from game_engine.game_manifests where id = v_ticket.manifest_id;
  if not coalesce((v_manifest.cancellation_correction_rules->>'allowBeforeCutoff')::boolean, false) then
    raise exception 'game manifest cancellation policy does not permit cancellation';
  end if;
  select * into v_reservation from public.credit_reservations
  where id = v_ticket.reservation_id for update;
  if not found or v_reservation.remaining_exposure <= 0 then
    raise exception 'ticket reservation cannot be cancelled';
  end if;

  v_release := credit_wallet_service.cancel_wallet_reservation(
    gen_random_uuid(),
    v_reservation.id,
    v_ticket.wallet_id,
    v_ticket.tenant_id,
    v_ticket.brand_id,
    v_ticket.player_account_id,
    'CREDIT',
    v_ticket.ticket_id,
    v_reservation.remaining_exposure,
    'ticket-cancellation:' || btrim(p_idempotency_key),
    p_correlation_id,
    p_reason_code
  );

  insert into ticket_authority.ticket_cancellation_requests (
    ticket_id,
    idempotency_key,
    reason_code,
    requested_by,
    reservation_release_id,
    canonical_request_hash
  )
  values (
    p_ticket_id,
    btrim(p_idempotency_key),
    p_reason_code,
    p_requested_by,
    nullif(v_release->>'releaseId', '')::uuid,
    v_request_hash
  )
  returning * into v_existing;

  update ticket_authority.tickets
  set status = 'CANCELLED'
  where ticket_id = p_ticket_id;
  perform ticket_authority.append_lifecycle_event(
    p_ticket_id,
    'AWAITING_DRAW',
    'CANCELLED',
    p_reason_code,
    p_requested_by,
    p_correlation_id,
    null,
    jsonb_build_object(
      'reservationId', v_ticket.reservation_id,
      'release', v_release
    )
  );
  insert into public.outbox_events (
    event_type,
    aggregate_type,
    aggregate_id,
    payload,
    status,
    correlation_id
  )
  values (
    'ticket.cancelled',
    'ticket',
    p_ticket_id::text,
    jsonb_build_object(
      'ticketId', p_ticket_id,
      'reservationId', v_ticket.reservation_id,
      'reasonCode', p_reason_code
    ),
    'PENDING',
    p_correlation_id
  );

  return jsonb_build_object(
    'cancelled', true,
    'duplicate', false,
    'ticketId', p_ticket_id,
    'cancellationId', v_existing.cancellation_id
  );
end;
$$;

create or replace function ticket_authority.record_correlation(
  p_ticket_id uuid,
  p_ticket_item_id uuid,
  p_correlation_type text,
  p_source_id text,
  p_source_hash text,
  p_operation_kind text,
  p_evidence jsonb,
  p_correlation_id text
)
returns jsonb
language plpgsql
as $$
declare
  v_ticket ticket_authority.tickets%rowtype;
  v_existing ticket_authority.ticket_correlations%rowtype;
  v_hash text;
  v_next_status text;
begin
  select * into v_ticket from ticket_authority.tickets
  where ticket_id = p_ticket_id for update;
  if not found then raise exception 'ticket not found'; end if;
  if p_source_hash !~ '^sha256:' then raise exception 'source hash is invalid'; end if;
  if p_ticket_item_id is not null then
    perform 1 from ticket_authority.ticket_items
    where ticket_item_id = p_ticket_item_id and ticket_id = p_ticket_id;
    if not found then raise exception 'ticket item does not belong to ticket'; end if;
  end if;

  v_hash := ticket_authority.hash_json(jsonb_build_object(
    'ticketId', p_ticket_id,
    'ticketItemId', p_ticket_item_id,
    'correlationType', p_correlation_type,
    'sourceId', p_source_id,
    'sourceHash', p_source_hash,
    'operationKind', p_operation_kind,
    'evidence', coalesce(p_evidence, '{}'::jsonb)
  ));
  select * into v_existing from ticket_authority.ticket_correlations
  where ticket_id = p_ticket_id
    and correlation_type = p_correlation_type
    and source_id = p_source_id
    and operation_kind = p_operation_kind;
  if found then
    if v_existing.canonical_correlation_hash <> v_hash then
      raise exception 'ticket correlation conflicts with existing evidence';
    end if;
    return jsonb_build_object(
      'recorded', true,
      'duplicate', true,
      'correlationEventId', v_existing.correlation_event_id
    );
  end if;

  insert into ticket_authority.ticket_correlations (
    ticket_id,
    ticket_item_id,
    correlation_type,
    source_id,
    source_hash,
    operation_kind,
    evidence,
    correlation_id,
    canonical_correlation_hash
  )
  values (
    p_ticket_id,
    p_ticket_item_id,
    p_correlation_type,
    p_source_id,
    p_source_hash,
    p_operation_kind,
    coalesce(p_evidence, '{}'::jsonb),
    p_correlation_id,
    v_hash
  )
  returning * into v_existing;

  v_next_status := case
    when p_correlation_type = 'OUTCOME'
      and v_ticket.status = 'AWAITING_DRAW' then 'SETTLEMENT_PENDING'
    when p_correlation_type = 'SETTLEMENT'
      and p_operation_kind = 'COMPLETED' then 'SETTLED'
    when p_correlation_type = 'DRAW_VOID' then 'VOIDED'
    else null
  end;
  if v_next_status is not null and v_next_status <> v_ticket.status then
    update ticket_authority.tickets
    set status = v_next_status
    where ticket_id = p_ticket_id;
    perform ticket_authority.append_lifecycle_event(
      p_ticket_id,
      v_ticket.status,
      v_next_status,
      p_correlation_type || '_' || p_operation_kind,
      'authority-correlation',
      p_correlation_id,
      p_source_id,
      jsonb_build_object(
        'sourceId', p_source_id,
        'sourceHash', p_source_hash,
        'correlationEventId', v_existing.correlation_event_id
      )
    );
  elsif p_correlation_type in ('REVERSAL', 'RESETTLEMENT') then
    perform ticket_authority.append_lifecycle_event(
      p_ticket_id,
      v_ticket.status,
      case when p_correlation_type = 'REVERSAL' then 'REVERSED' else 'RESETTLED' end,
      p_correlation_type || '_' || p_operation_kind,
      'authority-correlation',
      p_correlation_id,
      p_source_id,
      jsonb_build_object(
        'sourceId', p_source_id,
        'sourceHash', p_source_hash,
        'originalTicketStatus', v_ticket.status
      )
    );
  end if;

  return jsonb_build_object(
    'recorded', true,
    'duplicate', false,
    'correlationEventId', v_existing.correlation_event_id,
    'ticketStatus', coalesce(v_next_status, v_ticket.status)
  );
end;
$$;

create or replace function ticket_authority.ticket_readiness()
returns table (
  check_name text,
  ready boolean,
  issue_count bigint
)
language sql
stable
as $$
  with checks as (
    select 'migration_state'::text as check_name,
      exists (
        select 1 from platform_migrations.migration_history
        where migration_id = '083_add_canonical_ticket_lifecycle'
          and status = 'APPLIED'
      ) as ready,
      case when exists (
        select 1 from platform_migrations.migration_history
        where migration_id = '083_add_canonical_ticket_lifecycle'
          and status = 'APPLIED'
      ) then 0 else 1 end::bigint as issue_count
    union all
    select 'canonical_scope_binding',
      count(*) = 0,
      count(*)
    from ticket_authority.tickets ticket
    left join public.accounts account
      on account.id = ticket.player_account_id
     and account.governance_managed
     and account.status = 'ACTIVE'
     and account.canonical_tenant_id = ticket.tenant_id
     and account.canonical_brand_id = ticket.brand_id
     and account.canonical_market_id = ticket.market_id
    where account.id is null
    union all
    select 'product_manifest_paytable_binding',
      count(*) = 0,
      count(*)
    from ticket_authority.tickets ticket
    left join game_engine.game_definitions product on product.id = ticket.product_id
    left join game_engine.game_definition_versions product_version
      on product_version.id = ticket.product_version_id
    left join game_engine.game_manifests manifest on manifest.id = ticket.manifest_id
    left join game_engine.paytable_definitions paytable
      on paytable.id = ticket.paytable_definition_id
    left join platform.game_availability availability
      on availability.id = ticket.game_availability_id
    where product.id is null
       or product_version.id is null
       or manifest.id is null
       or paytable.id is null
       or availability.id is null
       or product_version.definition_hash <> ticket.game_configuration_hash
       or manifest.content_hash <> ticket.manifest_hash
       or paytable.content_hash <> ticket.paytable_hash
       or availability.content_hash <> ticket.game_availability_hash
    union all
    select 'draw_binding',
      count(*) = 0,
      count(*)
    from ticket_authority.tickets ticket
    left join game_engine.draw_schedules draw
      on draw.id = ticket.draw_id and draw.game_definition_id = ticket.product_id
    where draw.id is null
    union all
    select 'reservation_consistency',
      count(*) = 0,
      count(*)
    from ticket_authority.tickets ticket
    left join public.credit_reservations reservation
      on reservation.id = ticket.reservation_id
     and reservation.ticket_id = ticket.ticket_id::text
     and reservation.player_id = ticket.player_account_id
     and reservation.amount = ticket.total_stake_minor
     and reservation.currency = ticket.currency
    where reservation.id is null
    union all
    select 'ticket_outbox_atomicity',
      count(*) = 0,
      count(*)
    from ticket_authority.tickets ticket
    where not exists (
      select 1 from public.outbox_events event
      where event.event_type = 'ticket.accepted'
        and event.aggregate_type = 'ticket'
        and event.aggregate_id = ticket.ticket_id::text
    )
    union all
    select 'lifecycle_integrity',
      count(*) = 0,
      count(*)
    from ticket_authority.tickets ticket
    where not exists (
      select 1 from ticket_authority.ticket_lifecycle_events event
      where event.ticket_id = ticket.ticket_id and event.status = 'ACCEPTED'
    )
    union all
    select 'orphan_detection',
      count(*) = 0,
      count(*)
    from public.credit_reservations reservation
    where reservation.metadata->>'ticketAuthority' = 'true'
      and not exists (
        select 1 from ticket_authority.tickets ticket
        where ticket.ticket_id::text = reservation.ticket_id
          and ticket.reservation_id = reservation.id
      )
    union all
    select 'duplicate_idempotency_keys',
      count(*) = 0,
      count(*)
    from (
      select idempotency_key from ticket_authority.tickets
      group by idempotency_key having count(*) > 1
    ) duplicates
    union all
    select 'unresolved_acceptance_recovery',
      count(*) = 0,
      count(*)
    from ticket_authority.ticket_recovery_events
    where status = 'DETECTED'
      and not exists (
        select 1 from ticket_authority.ticket_recovery_events resolved
        where resolved.ticket_id is not distinct from ticket_recovery_events.ticket_id
          and resolved.recovery_type = ticket_recovery_events.recovery_type
          and resolved.status in ('RECOVERED', 'FAILED_CLOSED')
          and resolved.created_at >= ticket_recovery_events.created_at
      )
    union all
    select 'downstream_correlation_integrity',
      count(*) = 0,
      count(*)
    from ticket_authority.tickets ticket
    where ticket.status = 'SETTLED'
      and not exists (
        select 1 from ticket_authority.ticket_correlations correlation
        where correlation.ticket_id = ticket.ticket_id
          and correlation.correlation_type = 'SETTLEMENT'
      )
    union all
    select 'legacy_production_routes_disabled', true, 0::bigint
    union all
    select 'required_authority_dependencies',
      to_regclass('platform.game_availability') is not null
        and to_regclass('game_engine.draw_schedules') is not null
        and to_regclass('game_engine.game_manifests') is not null
        and to_regclass('game_engine.paytable_definitions') is not null
        and to_regclass('public.credit_reservations') is not null
        and to_regclass('public.outbox_events') is not null,
      case when
        to_regclass('platform.game_availability') is not null
        and to_regclass('game_engine.draw_schedules') is not null
        and to_regclass('game_engine.game_manifests') is not null
        and to_regclass('game_engine.paytable_definitions') is not null
        and to_regclass('public.credit_reservations') is not null
        and to_regclass('public.outbox_events') is not null
      then 0 else 1 end::bigint
  )
  select * from checks order by check_name;
$$;
