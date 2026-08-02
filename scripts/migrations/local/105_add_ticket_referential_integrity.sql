begin;

alter table game_engine.game_definition_versions
  add constraint ux_game_definition_version_lineage
    unique (id, game_definition_id, version_number, definition_hash, paytable_version);
alter table game_engine.game_manifests
  add constraint ux_game_manifest_lineage
    unique (id, game_id, semantic_version, content_hash);
alter table game_engine.paytable_definitions
  add constraint ux_paytable_definition_lineage
    unique (id, paytable_id, version, content_hash);
alter table game_engine.draw_schedules
  add constraint ux_draw_instance_game_definition unique (id, game_definition_id);
alter table game_engine.draw_execution_manifests
  add constraint ux_execution_manifest_ticket_lineage
    unique (
      execution_manifest_id, draw_id, game_definition_version_id,
      paytable_version, canonical_manifest_hash
    );
alter table public.financial_wallets
  add constraint ux_financial_wallet_ticket_lineage
    unique (id, account_id, wallet_type, currency_code);
alter table public.credit_reservations
  add constraint ux_credit_reservation_ticket_lineage
    unique (
      id, player_id, wallet_id, tenant_id, brand_id,
      instrument_code, currency, ticket_id, scope_model
    );

alter table public.financial_wallets
  drop constraint financial_wallets_account_id_fkey,
  add constraint financial_wallets_account_id_fkey
    foreign key (account_id) references public.accounts(id) on delete restrict;

alter table ticket_authority.tickets
  add column execution_manifest_id uuid,
  add column execution_manifest_hash text,
  add column lineage_model text;

update ticket_authority.tickets ticket
set execution_manifest_id = manifest.execution_manifest_id,
    execution_manifest_hash = manifest.canonical_manifest_hash,
    lineage_model = 'CANONICAL_V1'
from game_engine.draw_execution_manifests manifest
where manifest.draw_id = ticket.draw_id
  and manifest.game_definition_version_id = ticket.product_version_id
  and manifest.paytable_version = ticket.paytable_version;

update ticket_authority.tickets
set lineage_model = 'LEGACY_READ_ONLY'
where lineage_model is null;

do $$
begin
  if exists (
    select 1
    from ticket_authority.tickets ticket
    left join public.credit_reservations reservation
      on reservation.id = ticket.reservation_id
    left join public.financial_wallets wallet on wallet.id = ticket.wallet_id
    where ticket.lineage_model = 'CANONICAL_V1'
      and (
        row(wallet.account_id, wallet.wallet_type, wallet.currency_code)
          is distinct from
          row(ticket.player_account_id, ticket.funding_instrument, ticket.currency)
        or row(reservation.player_id, reservation.wallet_id,
               reservation.tenant_id, reservation.brand_id,
               reservation.instrument_code, reservation.currency,
               reservation.ticket_id, reservation.scope_model)
           is distinct from
           row(ticket.player_account_id, ticket.wallet_id,
               ticket.tenant_id, ticket.brand_id, ticket.funding_instrument,
               ticket.currency, ticket.ticket_id::text, 'CANONICAL'::text)
      )
  ) then
    raise exception using
      message = 'BF-5.5 cannot classify existing ticket as CANONICAL_V1: wallet or reservation lineage conflicts.',
      hint = 'Preserve the row as LEGACY_READ_ONLY or remediate it through an approved evidence process before rerunning migration 105.';
  end if;
end;
$$;

alter table ticket_authority.tickets
  alter column lineage_model set default 'CANONICAL_V1',
  alter column lineage_model set not null,
  add constraint ck_ticket_lineage_model
    check (lineage_model in ('CANONICAL_V1', 'LEGACY_READ_ONLY')),
  add constraint ck_canonical_ticket_execution_manifest
    check (
      lineage_model = 'LEGACY_READ_ONLY'
      or (
        execution_manifest_id is not null
        and execution_manifest_hash ~ '^sha256:'
      )
    ),
  add constraint fk_ticket_product_version_lineage
    foreign key (
      product_version_id, product_id, product_version,
      game_configuration_hash, paytable_version
    ) references game_engine.game_definition_versions(
      id, game_definition_id, version_number, definition_hash, paytable_version
    ) on delete restrict not valid,
  add constraint fk_ticket_manifest_lineage
    foreign key (manifest_id, product_id, manifest_version, manifest_hash)
    references game_engine.game_manifests(
      id, game_id, semantic_version, content_hash
    ) on delete restrict not valid,
  add constraint fk_ticket_paytable_lineage
    foreign key (paytable_definition_id, paytable_id, paytable_version, paytable_hash)
    references game_engine.paytable_definitions(id, paytable_id, version, content_hash)
    on delete restrict not valid,
  add constraint fk_ticket_draw_product_lineage
    foreign key (draw_id, product_id)
    references game_engine.draw_schedules(id, game_definition_id)
    on delete restrict not valid,
  add constraint fk_ticket_execution_manifest_lineage
    foreign key (
      execution_manifest_id, draw_id, product_version_id,
      paytable_version, execution_manifest_hash
    ) references game_engine.draw_execution_manifests(
      execution_manifest_id, draw_id, game_definition_version_id,
      paytable_version, canonical_manifest_hash
    ) on delete restrict not valid,
  add constraint fk_ticket_wallet_lineage
    foreign key (wallet_id, player_account_id, funding_instrument, currency)
    references public.financial_wallets(id, account_id, wallet_type, currency_code)
    on delete restrict not valid,
  add constraint ux_ticket_availability_lineage
    unique (ticket_id, game_availability_id),
  add constraint ux_ticket_lifecycle_lineage
    unique (ticket_id, lifecycle_version);

alter table ticket_authority.ticket_items
  add constraint ux_ticket_item_parent_lineage unique (ticket_item_id, ticket_id);
alter table ticket_authority.ticket_lifecycle_events
  add constraint ux_ticket_lifecycle_event_parent unique (event_id, ticket_id);
alter table ticket_completion_authority.completion_requests
  add constraint ux_completion_request_ticket unique (request_id, ticket_id);

alter table ticket_authority.availability_decisions
  add constraint fk_availability_decision_ticket_selection
    foreign key (ticket_id, selected_availability_id)
    references ticket_authority.tickets(ticket_id, game_availability_id)
    on delete restrict;
alter table ticket_completion_authority.completion_evidence
  add constraint fk_completion_evidence_request_ticket
    foreign key (request_id, ticket_id)
    references ticket_completion_authority.completion_requests(request_id, ticket_id)
    on delete restrict,
  add constraint fk_completion_evidence_lifecycle_ticket
    foreign key (lifecycle_terminal_event_id, ticket_id)
    references ticket_authority.ticket_lifecycle_events(event_id, ticket_id)
    on delete restrict;

create or replace function ticket_authority.bind_and_validate_ticket_lineage()
returns trigger
language plpgsql
as $$
declare
  v_manifest game_engine.draw_execution_manifests%rowtype;
  v_profile public.player_profiles%rowtype;
  v_account public.accounts%rowtype;
  v_reservation public.credit_reservations%rowtype;
  v_availability platform.game_availability%rowtype;
  v_tenant platform.tenants%rowtype;
  v_organization platform.organizations%rowtype;
  v_brand platform.brands%rowtype;
  v_market platform.markets%rowtype;
  v_website platform.websites%rowtype;
  v_domain platform.website_domains%rowtype;
  v_resolution funding_authority.resolution_events%rowtype;
begin
  if coalesce(new.lineage_model, 'CANONICAL_V1') <> 'CANONICAL_V1' then
    raise exception 'New tickets must use CANONICAL_V1 referential lineage.';
  end if;

  select * into v_manifest
  from game_engine.draw_execution_manifests
  where draw_id = new.draw_id;
  if not found then
    raise exception 'Canonical ticket requires one exact Draw Execution Manifest.';
  end if;
  new.execution_manifest_id := v_manifest.execution_manifest_id;
  new.execution_manifest_hash := v_manifest.canonical_manifest_hash;
  new.lineage_model := 'CANONICAL_V1';

  select * into v_profile from public.player_profiles where id = new.player_profile_id;
  select * into v_account from public.accounts where id = new.player_account_id;
  if not found or v_profile.account_id <> new.player_account_id then
    raise exception 'Canonical ticket player profile does not belong to the player account.';
  end if;
  if row(v_account.canonical_tenant_id, v_account.canonical_brand_id,
         v_account.canonical_market_id)
     is distinct from
     row(new.tenant_id, new.brand_id, new.market_id) then
    raise exception 'Canonical ticket account scope does not match authoritative hierarchy scope.';
  end if;

  select * into v_tenant from platform.tenants where id = new.tenant_id;
  select * into v_organization from platform.organizations where id = new.organization_id;
  select * into v_brand from platform.brands where id = new.brand_id;
  select * into v_market from platform.markets where id = new.market_id;
  if v_tenant.organization_id <> new.organization_id
     or v_organization.platform_id <> new.platform_id
     or v_brand.tenant_id <> new.tenant_id
     or v_market.brand_id <> new.brand_id then
    raise exception 'Canonical ticket tenant, brand, and market hierarchy is inconsistent.';
  end if;
  if new.website_id is not null then
    select * into v_website from platform.websites where id = new.website_id;
    if not found or v_website.tenant_id <> new.tenant_id
       or v_website.brand_id <> new.brand_id
       or (v_website.market_id is not null and v_website.market_id <> new.market_id) then
      raise exception 'Canonical ticket website is outside the authoritative scope.';
    end if;
  end if;
  if new.domain_id is not null then
    select * into v_domain from platform.website_domains where id = new.domain_id;
    if new.website_id is null or not found or v_domain.website_id <> new.website_id then
      raise exception 'Canonical ticket domain does not belong to the selected website.';
    end if;
  end if;

  select * into v_reservation from public.credit_reservations where id = new.reservation_id;
  if not found or v_reservation.scope_model <> 'CANONICAL'
     or row(v_reservation.player_id, v_reservation.wallet_id,
            v_reservation.tenant_id, v_reservation.brand_id,
            v_reservation.instrument_code, v_reservation.currency,
            v_reservation.ticket_id)
        is distinct from
        row(new.player_account_id, new.wallet_id, new.tenant_id, new.brand_id,
            new.funding_instrument, new.currency, new.ticket_id::text) then
    raise exception 'Canonical ticket reservation, wallet, player, scope, or funding lineage is inconsistent.';
  end if;

  select * into v_resolution
  from funding_authority.resolution_events where resolution_id = new.funding_resolution_id;
  if not found
     or row(v_resolution.player_account_id, v_resolution.wallet_id,
            v_resolution.funding_instrument, v_resolution.currency,
            v_resolution.reservation_type)
        is distinct from
        row(new.player_account_id, new.wallet_id, new.funding_instrument,
            new.currency, new.reservation_type) then
    raise exception 'Canonical ticket funding resolution does not match its immutable funding snapshot.';
  end if;

  select * into v_availability
  from platform.game_availability where id = new.game_availability_id;
  if not found
     or row(v_availability.tenant_id, v_availability.brand_id,
            v_availability.market_id, v_availability.game_code,
            v_availability.version, v_availability.content_hash)
        is distinct from
        row(new.tenant_id, new.brand_id, new.market_id, new.game_code,
            new.game_availability_version, new.game_availability_hash)
     or (v_availability.website_id is not null
         and v_availability.website_id is distinct from new.website_id) then
    raise exception 'Canonical ticket availability decision does not match its immutable scope and version.';
  end if;
  return new;
end;
$$;

create trigger trg_bind_ticket_referential_lineage
before insert on ticket_authority.tickets
for each row execute function ticket_authority.bind_and_validate_ticket_lineage();

create or replace function ticket_authority.guard_ticket_lineage_update()
returns trigger language plpgsql as $$
begin
  if row(new.execution_manifest_id, new.execution_manifest_hash, new.lineage_model)
     is distinct from
     row(old.execution_manifest_id, old.execution_manifest_hash, old.lineage_model) then
    raise exception 'Canonical ticket referential lineage is immutable.';
  end if;
  if old.lineage_model = 'LEGACY_READ_ONLY'
     and row(new.status, new.lifecycle_state, new.lifecycle_version)
         is distinct from row(old.status, old.lifecycle_state, old.lifecycle_version) then
    raise exception 'Legacy ticket history is read-only and cannot become production authority.';
  end if;
  return new;
end;
$$;

create trigger trg_guard_ticket_referential_lineage
before update on ticket_authority.tickets
for each row execute function ticket_authority.guard_ticket_lineage_update();

create or replace function ticket_authority.validate_ticket_item_lineage()
returns trigger language plpgsql as $$
declare v_manifest game_engine.game_manifests%rowtype;
begin
  select manifest.* into v_manifest
  from ticket_authority.tickets ticket
  join game_engine.game_manifests manifest on manifest.id = ticket.manifest_id
  where ticket.ticket_id = new.ticket_id;
  if not found then raise exception 'Ticket item parent lineage was not found.'; end if;
  if not v_manifest.wager_schemas @> jsonb_build_array(jsonb_build_object(
    'wagerType', new.wager_type, 'version', new.wager_version
  )) then
    raise exception 'Ticket item wager schema/version is not authorized by the parent manifest.';
  end if;
  return new;
end;
$$;

create trigger trg_validate_ticket_item_lineage
before insert on ticket_authority.ticket_items
for each row execute function ticket_authority.validate_ticket_item_lineage();

create or replace function ticket_completion_authority.validate_completion_source_lineage()
returns trigger language plpgsql as $$
declare
  v_ticket_id uuid;
  v_item_ticket_id uuid;
  v_settlement settlement_service.authoritative_settlement_records%rowtype;
  v_ledger_attempt settlement_service.financial_instruction_execution_attempts%rowtype;
  v_wallet_attempt settlement_service.financial_instruction_execution_attempts%rowtype;
begin
  select ticket_id into v_ticket_id
  from ticket_completion_authority.completion_requests where request_id = new.request_id;
  select ticket_id into v_item_ticket_id
  from ticket_authority.ticket_items where ticket_item_id = new.ticket_item_id;
  select * into v_settlement
  from settlement_service.authoritative_settlement_records where settlement_id = new.settlement_id;
  select * into v_ledger_attempt
  from settlement_service.financial_instruction_execution_attempts
  where attempt_id = new.ledger_execution_attempt_id;
  select * into v_wallet_attempt
  from settlement_service.financial_instruction_execution_attempts
  where attempt_id = new.wallet_execution_attempt_id;
  if v_ticket_id is null or v_item_ticket_id <> v_ticket_id
     or v_settlement.ticket_id <> v_ticket_id::text
     or v_settlement.ticket_line_id <> new.ticket_item_id::text then
    raise exception 'Completion source ticket, item, and Settlement lineage do not match.';
  end if;
  if v_ledger_attempt.settlement_id <> new.settlement_id
     or v_ledger_attempt.target_service <> 'ledger-service'
     or v_wallet_attempt.settlement_id <> new.settlement_id
     or v_wallet_attempt.target_service <> 'credit-wallet-service' then
    raise exception 'Completion source financial execution lineage does not match Settlement.';
  end if;
  return new;
end;
$$;

create trigger trg_validate_completion_source_lineage
before insert on ticket_completion_authority.completion_sources
for each row execute function ticket_completion_authority.validate_completion_source_lineage();

create or replace function ticket_completion_authority.validate_completion_evidence_lineage()
returns trigger language plpgsql as $$
declare v_event ticket_authority.ticket_lifecycle_events%rowtype;
begin
  select * into v_event from ticket_authority.ticket_lifecycle_events
  where event_id = new.lifecycle_terminal_event_id;
  if not found or v_event.ticket_id <> new.ticket_id
     or v_event.command_type <> 'MarkSettled'
     or v_event.source_reference <> new.completion_id::text
     or v_event.source_hash <> new.canonical_completion_hash then
    raise exception 'Completion evidence does not match the terminal ticket lifecycle event.';
  end if;
  return new;
end;
$$;

create trigger trg_validate_completion_evidence_lineage
before insert on ticket_completion_authority.completion_evidence
for each row execute function ticket_completion_authority.validate_completion_evidence_lineage();

create or replace function ticket_authority.validate_internal_lifecycle_source_lineage()
returns trigger language plpgsql as $$
declare
  v_ticket ticket_authority.tickets%rowtype;
  v_request ticket_completion_authority.completion_requests%rowtype;
  v_completion ticket_completion_authority.completion_evidence%rowtype;
  v_reservation public.credit_reservations%rowtype;
begin
  if new.command_type is null then return new; end if;
  select * into v_ticket from ticket_authority.tickets where ticket_id = new.ticket_id;
  if v_ticket.lineage_model <> 'CANONICAL_V1' then return new; end if;

  if new.command_type = 'AcceptTicket' then
    if new.source_reference <> new.ticket_id::text
       or new.source_hash <> v_ticket.acceptance_hash then
      raise exception 'AcceptTicket lifecycle evidence does not match canonical ticket evidence.';
    end if;
  elsif new.command_type = 'CreateReservation' then
    select * into v_reservation from public.credit_reservations
    where id::text = new.source_reference;
    if not found or v_reservation.id <> v_ticket.reservation_id
       or v_reservation.ticket_id <> new.ticket_id::text then
      raise exception 'CreateReservation lifecycle evidence does not match ticket reservation.';
    end if;
  elsif new.command_type in ('ConfirmSettlement', 'PostLedger', 'ApplyWallet') then
    select * into v_request from ticket_completion_authority.completion_requests
    where request_id::text = new.source_reference;
    if not found or v_request.ticket_id <> new.ticket_id
       or v_request.canonical_request_hash <> new.source_hash then
      raise exception 'Financial lifecycle evidence does not match Completion Authority request.';
    end if;
  elsif new.command_type in ('MarkSettled', 'MarkCommissionEligible', 'MarkRebateEligible') then
    select * into v_completion from ticket_completion_authority.completion_evidence
    where completion_id::text = new.source_reference;
    if not found or v_completion.ticket_id <> new.ticket_id
       or v_completion.canonical_completion_hash <> new.source_hash then
      raise exception 'Terminal lifecycle evidence does not match Completion Authority evidence.';
    end if;
  end if;
  return new;
end;
$$;

create constraint trigger trg_validate_internal_lifecycle_source_lineage
after insert on ticket_authority.ticket_lifecycle_events
deferrable initially deferred
for each row execute function ticket_authority.validate_internal_lifecycle_source_lineage();

create or replace function ticket_authority.ticket_referential_integrity_readiness()
returns table(check_name text, ready boolean, issue_count bigint)
language sql stable as $$
  select 'canonical_execution_manifest_lineage', count(*) = 0, count(*)
  from ticket_authority.tickets ticket
  where ticket.lineage_model = 'CANONICAL_V1'
    and not exists (
      select 1 from game_engine.draw_execution_manifests manifest
      where row(manifest.execution_manifest_id, manifest.draw_id,
                manifest.game_definition_version_id, manifest.paytable_version,
                manifest.canonical_manifest_hash)
            = row(ticket.execution_manifest_id, ticket.draw_id,
                  ticket.product_version_id, ticket.paytable_version,
                  ticket.execution_manifest_hash)
    )
  union all
  select 'canonical_wallet_reservation_lineage', count(*) = 0, count(*)
  from ticket_authority.tickets ticket
  join public.credit_reservations reservation on reservation.id = ticket.reservation_id
  join public.financial_wallets wallet on wallet.id = ticket.wallet_id
  where ticket.lineage_model = 'CANONICAL_V1'
    and (row(wallet.account_id, wallet.wallet_type, wallet.currency_code)
           is distinct from row(ticket.player_account_id, ticket.funding_instrument, ticket.currency)
      or row(reservation.player_id, reservation.wallet_id, reservation.tenant_id,
             reservation.brand_id, reservation.instrument_code, reservation.currency,
             reservation.ticket_id, reservation.scope_model)
         is distinct from row(ticket.player_account_id, ticket.wallet_id, ticket.tenant_id,
             ticket.brand_id, ticket.funding_instrument, ticket.currency,
             ticket.ticket_id::text, 'CANONICAL'::text))
  union all
  select 'completion_parent_lineage', count(*) = 0, count(*)
  from ticket_completion_authority.completion_evidence evidence
  join ticket_completion_authority.completion_requests request using(request_id)
  join ticket_authority.ticket_lifecycle_events event
    on event.event_id = evidence.lifecycle_terminal_event_id
  where request.ticket_id <> evidence.ticket_id
     or event.ticket_id <> evidence.ticket_id
     or event.command_type <> 'MarkSettled';
$$;

comment on column ticket_authority.tickets.lineage_model is
  'CANONICAL_V1 records satisfy permanent BF-5.5 lineage. LEGACY_READ_ONLY preserves pre-manifest history without fabricating evidence.';
comment on column ticket_authority.tickets.execution_manifest_id is
  'Exact immutable Draw Execution Manifest selected at acceptance; never resolved through an active pointer.';
comment on function ticket_authority.ticket_referential_integrity_readiness() is
  'Database-level BF-5.5 integrity evidence for canonical ticket, funding, and completion lineage.';

commit;
