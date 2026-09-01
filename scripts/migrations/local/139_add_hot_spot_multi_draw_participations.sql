begin;

create table game_engine.hot_spot_multi_draw_participations (
  participation_id uuid primary key,
  purchase_id uuid not null
    references game_engine.hot_spot_multi_draw_purchases(purchase_id) on delete restrict,
  binding_id uuid not null
    references game_engine.hot_spot_multi_draw_bindings(binding_id) on delete restrict,
  ticket_id uuid not null references ticket_authority.tickets(ticket_id) on delete restrict,
  ticket_item_id uuid not null
    references ticket_authority.ticket_items(ticket_item_id) on delete restrict,
  base_ticket_item_id uuid not null
    references ticket_authority.ticket_items(ticket_item_id) on delete restrict,
  draw_id uuid not null references game_engine.durable_scheduler_draws(draw_id) on delete restrict,
  draw_sequence integer not null check (draw_sequence > 0),
  allocated_stake_minor bigint not null check (allocated_stake_minor > 0),
  participation_hash text not null unique
    check (participation_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null,
  unique (purchase_id, binding_id, base_ticket_item_id),
  unique (ticket_item_id)
);

create table game_engine.hot_spot_multi_draw_participation_events (
  event_id uuid primary key,
  participation_id uuid not null
    references game_engine.hot_spot_multi_draw_participations(participation_id) on delete restrict,
  event_type text not null check (event_type in ('CANCELLED')),
  reason_code text not null check (btrim(reason_code) <> ''),
  requested_by text not null check (btrim(requested_by) <> ''),
  idempotency_key text not null,
  correlation_id text not null,
  wallet_operation_id uuid
    references credit_wallet_service.wallet_operation_requests(operation_id) on delete restrict,
  evidence_hash text not null unique
    check (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (participation_id, event_type),
  unique (idempotency_key, participation_id)
);

create table game_engine.hot_spot_multi_draw_cancellations (
  cancellation_id uuid primary key,
  purchase_id uuid not null
    references game_engine.hot_spot_multi_draw_purchases(purchase_id) on delete restrict,
  idempotency_key text not null unique,
  canonical_request_hash text not null unique
    check (canonical_request_hash ~ '^sha256:[0-9a-f]{64}$'),
  cancelled_participation_count integer not null check (cancelled_participation_count > 0),
  released_amount_minor bigint not null check (released_amount_minor > 0),
  wallet_operation_id uuid not null unique
    references credit_wallet_service.wallet_operation_requests(operation_id) on delete restrict,
  reason_code text not null,
  requested_by text not null,
  correlation_id text not null,
  evidence_hash text not null unique
    check (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create index idx_hot_spot_multi_draw_participation_draw
  on game_engine.hot_spot_multi_draw_participations(draw_id, ticket_id, ticket_item_id);
create index idx_hot_spot_multi_draw_participation_ticket
  on game_engine.hot_spot_multi_draw_participations(ticket_id, draw_sequence, base_ticket_item_id);
create index idx_hot_spot_multi_draw_participation_events
  on game_engine.hot_spot_multi_draw_participation_events(participation_id, created_at);

create trigger trg_hot_spot_multi_draw_participations_immutable
before update or delete on game_engine.hot_spot_multi_draw_participations
for each row execute function game_engine.prevent_durable_scheduler_evidence_mutation();
create trigger trg_hot_spot_multi_draw_participation_events_immutable
before update or delete on game_engine.hot_spot_multi_draw_participation_events
for each row execute function game_engine.prevent_durable_scheduler_evidence_mutation();
create trigger trg_hot_spot_multi_draw_cancellations_immutable
before update or delete on game_engine.hot_spot_multi_draw_cancellations
for each row execute function game_engine.prevent_durable_scheduler_evidence_mutation();

create or replace function game_engine.validate_hot_spot_multi_draw_participation()
returns trigger language plpgsql as $$
declare
  v_binding game_engine.hot_spot_multi_draw_bindings%rowtype;
  v_item ticket_authority.ticket_items%rowtype;
begin
  select * into v_binding
  from game_engine.hot_spot_multi_draw_bindings
  where binding_id = new.binding_id and purchase_id = new.purchase_id;
  if not found
     or v_binding.ticket_id <> new.ticket_id
     or v_binding.draw_id <> new.draw_id
     or v_binding.sequence <> new.draw_sequence then
    raise exception 'Hot Spot participation does not match its immutable draw binding.';
  end if;
  select * into v_item from ticket_authority.ticket_items
  where ticket_item_id = new.ticket_item_id and ticket_id = new.ticket_id;
  if not found or v_item.stake_minor <> new.allocated_stake_minor then
    raise exception 'Hot Spot participation does not match its immutable ticket item allocation.';
  end if;
  perform 1 from ticket_authority.ticket_items
  where ticket_item_id = new.base_ticket_item_id and ticket_id = new.ticket_id;
  if not found then
    raise exception 'Hot Spot participation base ticket item is invalid.';
  end if;
  return new;
end;
$$;

create trigger trg_validate_hot_spot_multi_draw_participation
before insert on game_engine.hot_spot_multi_draw_participations
for each row execute function game_engine.validate_hot_spot_multi_draw_participation();

create or replace function game_engine.validate_hot_spot_multi_draw_purchase()
returns trigger language plpgsql as $$
declare
  v_ticket ticket_authority.tickets%rowtype;
  v_reservation public.credit_reservations%rowtype;
  v_base_stake bigint;
  v_item_count integer;
begin
  select * into v_ticket from ticket_authority.tickets where ticket_id = new.ticket_id;
  if not found or v_ticket.game_code <> 'HOT_SPOT_V1' then
    raise exception 'Multi-draw purchase requires a canonical Hot Spot ticket.';
  end if;
  select count(*)::integer, coalesce(sum(stake_minor), 0)::bigint
    into v_item_count, v_base_stake
  from ticket_authority.ticket_items
  where ticket_id = new.ticket_id;
  if v_item_count = 0 or v_base_stake <> new.stake_per_draw_minor then
    raise exception 'Multi-draw stake must equal the accepted per-draw ticket allocation.';
  end if;
  if exists (
    select 1 from ticket_authority.ticket_items
    where ticket_id = new.ticket_id
      and coalesce((normalized_selections->>'multiDrawCount')::integer, 1) <> new.draw_count
  ) then
    raise exception 'Every Hot Spot play must bind the same accepted multi-draw count.';
  end if;
  if v_ticket.total_stake_minor <> new.total_reservation_minor then
    raise exception 'Canonical Hot Spot ticket total must equal the full multi-draw reservation.';
  end if;
  select * into v_reservation from public.credit_reservations where id = v_ticket.reservation_id;
  if not found or v_reservation.reserved_amount <> new.total_reservation_minor then
    raise exception 'Multi-draw purchase requires one exact full upfront authoritative reservation.';
  end if;
  return new;
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
  v_updated := replace(v_definition,
    '  v_distinct_spot_count integer;',
    '  v_distinct_spot_count integer;' || E'\n' ||
    '  v_multi_draw_count integer := 1;' || E'\n' ||
    '  v_item_draw_count integer;');
  if v_updated = v_definition then
    raise exception 'Hot Spot multi-draw acceptance could not add draw-count state.';
  end if;
  v_definition := v_updated;

  v_updated := replace(v_definition,
    '      v_item_stake := coalesce((v_item->>''stakeMinor'')::bigint, 0);',
    '      v_item_stake := coalesce((v_item->>''stakeMinor'')::bigint, 0);' || E'\n' ||
    '      v_item_draw_count := coalesce((v_item #>> ''{selections,multiDrawCount}'')::integer, 1);' || E'\n' ||
    '      if v_item_draw_count not in (1, 5, 10, 20) then' || E'\n' ||
    '        raise exception ''Hot Spot multi-draw count must be 1, 5, 10, or 20'';' || E'\n' ||
    '      end if;' || E'\n' ||
    '      if v_multi_draw_count = 1 then v_multi_draw_count := v_item_draw_count;' || E'\n' ||
    '      elsif v_multi_draw_count <> v_item_draw_count then' || E'\n' ||
    '        raise exception ''Every Hot Spot play must use the same multi-draw count'';' || E'\n' ||
    '      end if;');
  if v_updated = v_definition then
    raise exception 'Hot Spot multi-draw acceptance could not validate play draw counts.';
  end if;
  v_definition := v_updated;

  v_updated := replace(v_definition,
    '    v_total := v_total + coalesce((v_item->>''stakeMinor'')::bigint, 0);',
    '    v_total := v_total + coalesce((v_item->>''stakeMinor'')::bigint, 0) *' || E'\n' ||
    '      case when v_product.code = ''HOT_SPOT_V1'' then v_multi_draw_count else 1 end;');
  if v_updated = v_definition then
    raise exception 'Hot Spot multi-draw acceptance could not reserve the full purchase amount.';
  end if;
  execute v_updated;
end;
$$;

do $$
declare
  v_identity regprocedure :=
    'ticket_authority.persist_authorized_ticket(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,jsonb,text,text,text,text,text)'::regprocedure;
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(v_identity) into v_definition;
  v_updated := replace(v_definition,
    '  v_master_agent_id uuid;',
    '  v_master_agent_id uuid;' || E'\n' ||
    '  v_multi_draw_count integer := 1;' || E'\n' ||
    '  v_item_draw_count integer;');
  if v_updated = v_definition then
    raise exception 'Authorized ticket persistence could not add multi-draw state.';
  end if;
  v_definition := v_updated;

  v_updated := replace(v_definition,
    '    v_total := v_total + (v_item->>''stakeMinor'')::bigint;',
    '    v_item_draw_count := coalesce((v_item #>> ''{selections,multiDrawCount}'')::integer, 1);' || E'\n' ||
    '    if v_product.code = ''HOT_SPOT_V1'' then' || E'\n' ||
    '      if v_item_draw_count not in (1, 5, 10, 20) then' || E'\n' ||
    '        raise exception ''Hot Spot multi-draw count must be 1, 5, 10, or 20'';' || E'\n' ||
    '      end if;' || E'\n' ||
    '      if v_multi_draw_count = 1 then v_multi_draw_count := v_item_draw_count;' || E'\n' ||
    '      elsif v_multi_draw_count <> v_item_draw_count then' || E'\n' ||
    '        raise exception ''Every Hot Spot play must use the same multi-draw count'';' || E'\n' ||
    '      end if;' || E'\n' ||
    '    elsif v_item_draw_count <> 1 then' || E'\n' ||
    '      raise exception ''Multi-draw count is supported only for Hot Spot'';' || E'\n' ||
    '    end if;' || E'\n' ||
    '    v_total := v_total + (v_item->>''stakeMinor'')::bigint * v_item_draw_count;');
  if v_updated = v_definition then
    raise exception 'Authorized ticket persistence could not reserve multi-draw exposure.';
  end if;
  execute v_updated;
end;
$$;

alter table ticket_completion_authority.completion_requests
  add column cancelled_participation_count integer not null default 0
    check (cancelled_participation_count >= 0);
alter table ticket_completion_authority.completion_evidence
  add column cancelled_participation_count integer not null default 0
    check (cancelled_participation_count >= 0);

do $$
declare
  v_identity regprocedure :=
    'ticket_completion_authority.complete_ticket(uuid,jsonb,text,text,text,text)'::regprocedure;
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(v_identity) into v_definition;
  v_updated := replace(v_definition,
    '  v_source_count integer;',
    '  v_source_count integer;' || E'\n' || '  v_cancelled_count integer := 0;');
  if v_updated = v_definition then
    raise exception 'Ticket Completion Authority could not add cancellation state.';
  end if;
  v_definition := v_updated;

  v_updated := replace(v_definition,
    '  select count(*)::integer into v_item_count' || E'\n' ||
    '  from ticket_authority.ticket_items where ticket_id = p_ticket_id;',
    '  select count(*) filter (where cancellation.participation_id is null)::integer,' || E'\n' ||
    '    count(*) filter (where cancellation.participation_id is not null)::integer' || E'\n' ||
    '  into v_item_count, v_cancelled_count' || E'\n' ||
    '  from ticket_authority.ticket_items item' || E'\n' ||
    '  left join game_engine.hot_spot_multi_draw_participations participation' || E'\n' ||
    '    on participation.ticket_item_id = item.ticket_item_id' || E'\n' ||
    '  left join game_engine.hot_spot_multi_draw_participation_events cancellation' || E'\n' ||
    '    on cancellation.participation_id = participation.participation_id' || E'\n' ||
    '   and cancellation.event_type = ''CANCELLED''' || E'\n' ||
    '  where item.ticket_id = p_ticket_id;');
  if v_updated = v_definition then
    raise exception 'Ticket Completion Authority could not gate multi-draw completion.';
  end if;
  v_definition := v_updated;

  v_updated := replace(v_definition,
    '    actor_reference, correlation_id, causation_id' || E'\n' ||
    '  ) values (',
    '    actor_reference, correlation_id, causation_id, cancelled_participation_count' || E'\n' ||
    '  ) values (');
  v_updated := replace(v_updated,
    '    btrim(p_actor_reference), btrim(p_correlation_id), p_causation_id' || E'\n' ||
    '  );',
    '    btrim(p_actor_reference), btrim(p_correlation_id), p_causation_id, v_cancelled_count' || E'\n' ||
    '  );');
  v_updated := replace(v_updated,
    '''ticketId'', p_ticket_id, ''sourceHashes'', v_source_hashes',
    '''ticketId'', p_ticket_id, ''sourceHashes'', v_source_hashes,' || E'\n' ||
    '    ''cancelledParticipationCount'', v_cancelled_count');
  v_updated := replace(v_updated,
    '    lifecycle_terminal_event_id, canonical_completion_hash' || E'\n' ||
    '  ) values (',
    '    lifecycle_terminal_event_id, canonical_completion_hash, cancelled_participation_count' || E'\n' ||
    '  ) values (');
  v_updated := replace(v_updated,
    '    v_terminal_event_id, v_completion_hash' || E'\n' ||
    '  );',
    '    v_terminal_event_id, v_completion_hash, v_cancelled_count' || E'\n' ||
    '  );');
  execute v_updated;
end;
$$;

create or replace function game_engine.cancel_hot_spot_future_participations(
  p_purchase_id uuid,
  p_idempotency_key text,
  p_reason_code text,
  p_requested_by text,
  p_correlation_id text,
  p_cancelled_at timestamptz
) returns jsonb
language plpgsql
as $$
declare
  v_purchase game_engine.hot_spot_multi_draw_purchases%rowtype;
  v_ticket ticket_authority.tickets%rowtype;
  v_reservation public.credit_reservations%rowtype;
  v_existing game_engine.hot_spot_multi_draw_cancellations%rowtype;
  v_cancellation_id uuid := gen_random_uuid();
  v_operation_id uuid := gen_random_uuid();
  v_release_id uuid;
  v_cancelled_count integer;
  v_release_amount bigint;
  v_remaining_count integer;
  v_request_hash text;
  v_wallet_request_hash text;
  v_evidence_hash text;
  v_release jsonb;
  v_completion_sources jsonb;
  v_completion_result jsonb;
  v_completed_at timestamptz;
begin
  if p_purchase_id is null
     or nullif(btrim(p_idempotency_key), '') is null
     or nullif(btrim(p_reason_code), '') is null
     or nullif(btrim(p_requested_by), '') is null
     or nullif(btrim(p_correlation_id), '') is null then
    raise exception 'Hot Spot future cancellation requires complete governed request metadata.';
  end if;
  v_request_hash := ticket_authority.hash_json(jsonb_build_object(
    'purchaseId', p_purchase_id,
    'reasonCode', btrim(p_reason_code),
    'requestedBy', btrim(p_requested_by),
    'correlationId', btrim(p_correlation_id)
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'hot-spot-future-cancel:' || p_purchase_id::text, 0));

  select * into v_existing
  from game_engine.hot_spot_multi_draw_cancellations
  where idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_existing.purchase_id <> p_purchase_id
       or v_existing.canonical_request_hash <> v_request_hash then
      raise exception 'Hot Spot future cancellation idempotency payload conflict.';
    end if;
    return jsonb_build_object(
      'cancellationId', v_existing.cancellation_id,
      'purchaseId', v_existing.purchase_id,
      'cancelledParticipationCount', v_existing.cancelled_participation_count,
      'releasedAmountMinor', v_existing.released_amount_minor,
      'walletOperationId', v_existing.wallet_operation_id,
      'evidenceHash', v_existing.evidence_hash,
      'cancelledAt', v_existing.created_at,
      'duplicate', true
    );
  end if;

  select * into v_purchase
  from game_engine.hot_spot_multi_draw_purchases
  where purchase_id = p_purchase_id;
  if not found then raise exception 'Hot Spot multi-draw purchase was not found.'; end if;
  select * into v_ticket from ticket_authority.tickets
  where ticket_id = v_purchase.ticket_id for update;
  select * into v_reservation from public.credit_reservations
  where id = v_ticket.reservation_id for update;
  if v_ticket.ticket_id is null or v_reservation.id is null then
    raise exception 'Canonical ticket reservation is unavailable for future cancellation.';
  end if;

  with cancellable as (
    select participation.participation_id, participation.allocated_stake_minor
    from game_engine.hot_spot_multi_draw_participations participation
    join game_engine.durable_scheduler_draws draw on draw.draw_id = participation.draw_id
    where participation.purchase_id = p_purchase_id
      and draw.scheduled_execution_at > p_cancelled_at
      and not exists (
        select 1 from game_engine.canonical_outcome_versions outcome
        where outcome.draw_id = participation.draw_id
      )
      and not exists (
        select 1 from settlement_service.authoritative_settlement_records settlement
        where settlement.ticket_id = participation.ticket_id::text
          and settlement.ticket_line_id = participation.ticket_item_id::text
      )
      and not exists (
        select 1 from game_engine.hot_spot_multi_draw_participation_events event
        where event.participation_id = participation.participation_id
          and event.event_type = 'CANCELLED'
      )
  )
  select count(*)::integer, coalesce(sum(allocated_stake_minor), 0)::bigint
    into v_cancelled_count, v_release_amount
  from cancellable;
  if v_cancelled_count = 0 or v_release_amount <= 0 then
    raise exception 'No undrawn Hot Spot participations are available for cancellation.';
  end if;
  select count(*)::integer into v_remaining_count
  from game_engine.hot_spot_multi_draw_participations participation
  where participation.purchase_id = p_purchase_id
    and not exists (
      select 1 from game_engine.durable_scheduler_draws draw
      where draw.draw_id = participation.draw_id
        and draw.scheduled_execution_at > p_cancelled_at
        and not exists (
          select 1 from game_engine.canonical_outcome_versions outcome
          where outcome.draw_id = participation.draw_id
        )
    );
  if v_remaining_count = 0 then
    raise exception 'Use canonical whole-ticket cancellation before any multi-draw participation executes.';
  end if;
  if v_release_amount > v_reservation.remaining_exposure then
    raise exception 'Future cancellation exceeds the remaining authoritative reservation exposure.';
  end if;

  v_wallet_request_hash := ticket_authority.hash_json(jsonb_build_object(
    'operation', 'RELEASE',
    'ticketId', v_ticket.ticket_id,
    'purchaseId', p_purchase_id,
    'reservationId', v_reservation.id,
    'amountMinor', v_release_amount,
    'reasonCode', btrim(p_reason_code)
  ));
  insert into credit_wallet_service.wallet_operation_requests(
    operation_id, request_id, idempotency_key, canonical_request_hash,
    operation_type, authority, tenant_id, brand_id, player_id, wallet_id,
    instrument_code, currency, amount_minor, ticket_id, reservation_id,
    reason_code, source_service, effective_at, correlation_id, audit_metadata
  ) values (
    v_operation_id, v_operation_id,
    'hot-spot-future-cancellation:' || btrim(p_idempotency_key),
    v_wallet_request_hash, 'RELEASE', 'ticket-authority',
    v_ticket.tenant_id, v_ticket.brand_id, v_ticket.player_account_id,
    v_ticket.wallet_id, v_ticket.funding_instrument, v_ticket.currency,
    v_release_amount, v_ticket.ticket_id, v_ticket.reservation_id,
    btrim(p_reason_code), 'game-engine', p_cancelled_at,
    btrim(p_correlation_id), jsonb_build_object(
      'hotSpotMultiDraw', true,
      'purchaseId', p_purchase_id,
      'requestedBy', btrim(p_requested_by)
    )
  );
  v_release := credit_wallet_service.release_wallet_reservation(
    v_operation_id, v_reservation.id, v_ticket.wallet_id,
    v_ticket.tenant_id, v_ticket.brand_id, v_ticket.player_account_id,
    v_ticket.funding_instrument, v_ticket.ticket_id::text, v_release_amount,
    v_ticket.currency,
    'hot-spot-future-cancellation:' || btrim(p_idempotency_key),
    btrim(p_correlation_id), btrim(p_reason_code),
    jsonb_build_object('hotSpotMultiDraw', true, 'purchaseId', p_purchase_id)
  );
  select id into v_release_id from public.credit_reservation_releases
  where operation_id = v_operation_id;
  if v_release_id is null then
    raise exception 'Future cancellation did not create authoritative release evidence.';
  end if;
  v_completed_at := clock_timestamp();
  insert into credit_wallet_service.wallet_operation_attempts(
    attempt_id, operation_id, attempt_number, result, started_at, completed_at,
    canonical_evidence_hash, audit_metadata
  ) values (
    gen_random_uuid(), v_operation_id, 1, 'SUCCEEDED', v_completed_at, v_completed_at,
    ticket_authority.hash_json(jsonb_build_object(
      'operationId', v_operation_id, 'result', 'SUCCEEDED',
      'releaseId', v_release_id, 'release', v_release
    )), jsonb_build_object('hotSpotMultiDraw', true)
  );
  insert into credit_wallet_service.wallet_operation_terminal_results(
    terminal_result_id, operation_id, terminal_status, effect_reference_type,
    effect_reference_id, result_payload, result_hash, completed_at
  ) values (
    gen_random_uuid(), v_operation_id, 'COMMITTED',
    'credit_reservation_release', v_release_id::text, v_release,
    ticket_authority.hash_json(jsonb_build_object(
      'operationId', v_operation_id, 'terminalStatus', 'COMMITTED',
      'releaseId', v_release_id, 'release', v_release
    )), v_completed_at
  );

  insert into game_engine.hot_spot_multi_draw_participation_events(
    event_id, participation_id, event_type, reason_code, requested_by,
    idempotency_key, correlation_id, wallet_operation_id, evidence_hash, created_at)
  select gen_random_uuid(), participation.participation_id, 'CANCELLED',
    btrim(p_reason_code), btrim(p_requested_by), btrim(p_idempotency_key),
    btrim(p_correlation_id), v_operation_id,
    ticket_authority.hash_json(jsonb_build_object(
      'purchaseId', p_purchase_id,
      'participationId', participation.participation_id,
      'drawId', participation.draw_id,
      'drawSequence', participation.draw_sequence,
      'releasedAmountMinor', participation.allocated_stake_minor,
      'walletOperationId', v_operation_id,
      'reasonCode', btrim(p_reason_code)
    )), p_cancelled_at
  from game_engine.hot_spot_multi_draw_participations participation
  join game_engine.durable_scheduler_draws draw on draw.draw_id = participation.draw_id
  where participation.purchase_id = p_purchase_id
    and draw.scheduled_execution_at > p_cancelled_at
    and not exists (
      select 1 from game_engine.canonical_outcome_versions outcome
      where outcome.draw_id = participation.draw_id
    )
    and not exists (
      select 1 from settlement_service.authoritative_settlement_records settlement
      where settlement.ticket_id = participation.ticket_id::text
        and settlement.ticket_line_id = participation.ticket_item_id::text
    );

  v_evidence_hash := ticket_authority.hash_json(jsonb_build_object(
    'cancellationId', v_cancellation_id,
    'purchaseId', p_purchase_id,
    'cancelledParticipationCount', v_cancelled_count,
    'releasedAmountMinor', v_release_amount,
    'walletOperationId', v_operation_id,
    'reasonCode', btrim(p_reason_code)
  ));
  insert into game_engine.hot_spot_multi_draw_cancellations(
    cancellation_id, purchase_id, idempotency_key, canonical_request_hash,
    cancelled_participation_count, released_amount_minor, wallet_operation_id,
    reason_code, requested_by, correlation_id, evidence_hash, created_at
  ) values (
    v_cancellation_id, p_purchase_id, btrim(p_idempotency_key), v_request_hash,
    v_cancelled_count, v_release_amount, v_operation_id, btrim(p_reason_code),
    btrim(p_requested_by), btrim(p_correlation_id), v_evidence_hash, p_cancelled_at
  ) returning * into v_existing;

  select jsonb_agg(jsonb_build_object(
      'ticketItemId', source.ticket_item_id,
      'settlementId', source.settlement_id,
      'ledgerExecutionAttemptId', source.ledger_attempt_id,
      'ledgerPostingRequestId', source.ledger_request_id,
      'walletExecutionAttemptId', source.wallet_attempt_id,
      'walletOperationId', source.wallet_operation_id
    ) order by source.ticket_item_id)
  into v_completion_sources
  from (
    select item.ticket_item_id,
      settlement.settlement_id,
      ledger_attempt.attempt_id ledger_attempt_id,
      ledger_request.id ledger_request_id,
      wallet_attempt.attempt_id wallet_attempt_id,
      wallet_request.operation_id wallet_operation_id
    from ticket_authority.ticket_items item
    left join game_engine.hot_spot_multi_draw_participations participation
      on participation.ticket_item_id = item.ticket_item_id
    left join game_engine.hot_spot_multi_draw_participation_events cancellation
      on cancellation.participation_id = participation.participation_id
     and cancellation.event_type = 'CANCELLED'
    join lateral (
      select (array_agg(record.settlement_id order by record.issued_at))[1] settlement_id
      from settlement_service.authoritative_settlement_records record
      where record.ticket_id = item.ticket_id::text
        and record.ticket_line_id = item.ticket_item_id::text
      having count(*) = 1
    ) settlement on true
    join lateral (
      select (array_agg(attempt.attempt_id order by attempt.created_at))[1] attempt_id,
        (array_agg(attempt.external_reference_id order by attempt.created_at))[1] external_reference_id
      from settlement_service.financial_instruction_execution_attempts attempt
      where attempt.settlement_id = settlement.settlement_id
        and attempt.target_service = 'ledger-service'
        and attempt.status in ('Posted', 'Skipped')
      having count(*) = 1
    ) ledger_attempt on true
    left join ledger_service.ledger_posting_requests ledger_request
      on ledger_request.id = case
        when ledger_attempt.external_reference_id ~* '^[0-9a-f-]{36}$'
        then ledger_attempt.external_reference_id::uuid
      end
    join lateral (
      select (array_agg(attempt.attempt_id order by attempt.created_at))[1] attempt_id,
        (array_agg(attempt.external_reference_id order by attempt.created_at))[1] external_reference_id
      from settlement_service.financial_instruction_execution_attempts attempt
      where attempt.settlement_id = settlement.settlement_id
        and attempt.target_service = 'credit-wallet-service'
        and attempt.status in ('Posted', 'Skipped')
      having count(*) = 1
    ) wallet_attempt on true
    left join credit_wallet_service.wallet_operation_requests wallet_request
      on wallet_request.operation_id = case
        when wallet_attempt.external_reference_id ~* '^[0-9a-f-]{36}$'
        then wallet_attempt.external_reference_id::uuid
      end
    where item.ticket_id = v_ticket.ticket_id
      and cancellation.participation_id is null
  ) source;

  if v_completion_sources is not null
     and jsonb_array_length(v_completion_sources) = v_remaining_count then
    v_completion_result := ticket_completion_authority.complete_ticket(
      v_ticket.ticket_id,
      v_completion_sources,
      'ticket-financial-completion:' || v_ticket.ticket_id::text,
      'game-engine-multi-draw-cancellation',
      btrim(p_correlation_id),
      v_cancellation_id::text
    );
  end if;

  return jsonb_build_object(
    'cancellationId', v_existing.cancellation_id,
    'purchaseId', v_existing.purchase_id,
    'cancelledParticipationCount', v_existing.cancelled_participation_count,
    'releasedAmountMinor', v_existing.released_amount_minor,
    'walletOperationId', v_existing.wallet_operation_id,
    'evidenceHash', v_existing.evidence_hash,
    'completionEvidence', v_completion_result,
    'cancelledAt', v_existing.created_at,
    'duplicate', false
  );
end;
$$;

comment on table game_engine.hot_spot_multi_draw_participations is
  'Immutable per-draw financial participation lines for one accepted Hot Spot multi-draw ticket.';
comment on table game_engine.hot_spot_multi_draw_participation_events is
  'Append-only future-only cancellation evidence; completed participations are never rewritten.';

commit;
