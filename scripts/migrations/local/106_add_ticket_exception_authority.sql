begin;

create schema if not exists ticket_exception_authority;

create or replace function ticket_exception_authority.hash_json(p_value jsonb)
returns text language sql immutable strict as $$
  select 'sha256:' || encode(digest(convert_to(p_value::text, 'UTF8'), 'sha256'), 'hex')
$$;

create table ticket_exception_authority.operations (
  operation_id uuid primary key default gen_random_uuid(),
  operation_type text not null check (operation_type in (
    'VOID', 'SETTLEMENT_REVERSAL', 'RESETTLEMENT', 'DRAW_CANCELLATION'
  )),
  ticket_id uuid not null references ticket_authority.tickets(ticket_id) on delete restrict,
  expected_lifecycle_version integer not null check (expected_lifecycle_version > 0),
  idempotency_key text not null unique check (btrim(idempotency_key) <> ''),
  canonical_command_hash text not null unique check (canonical_command_hash ~ '^sha256:[0-9a-f]{64}$'),
  source_authority text not null check (btrim(source_authority) <> ''),
  source_reference text not null check (btrim(source_reference) <> ''),
  source_hash text not null check (source_hash ~ '^sha256:[0-9a-f]{64}$'),
  original_completion_id uuid references ticket_completion_authority.completion_evidence(completion_id) on delete restrict,
  prior_operation_id uuid references ticket_exception_authority.operations(operation_id) on delete restrict,
  corrected_outcome_version_id uuid references game_engine.canonical_outcome_versions(outcome_version_id) on delete restrict,
  actor_reference text not null check (btrim(actor_reference) <> ''),
  reason_code text not null check (btrim(reason_code) <> ''),
  correlation_id text not null check (btrim(correlation_id) <> ''),
  causation_id text,
  requested_at timestamptz not null default now(),
  check (prior_operation_id is null or prior_operation_id <> operation_id),
  check (
    (operation_type = 'RESETTLEMENT' and prior_operation_id is not null and corrected_outcome_version_id is not null)
    or (operation_type <> 'RESETTLEMENT' and corrected_outcome_version_id is null)
  ),
  check (
    (operation_type in ('SETTLEMENT_REVERSAL', 'RESETTLEMENT') and original_completion_id is not null)
    or operation_type = 'DRAW_CANCELLATION'
    or (operation_type = 'VOID' and original_completion_id is null)
  )
);

create table ticket_exception_authority.operation_events (
  event_id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references ticket_exception_authority.operations(operation_id) on delete restrict,
  event_sequence integer not null check (event_sequence > 0),
  operation_state text not null check (operation_state in (
    'Requested', 'InProgress', 'PartiallyCompleted', 'Completed',
    'FailedRecoverable', 'FailedTerminal'
  )),
  event_type text not null check (btrim(event_type) <> ''),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  failure_classification text,
  recoverable boolean not null,
  canonical_evidence_hash text not null unique check (canonical_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (operation_id, event_sequence)
);

create table ticket_exception_authority.operation_projection (
  operation_id uuid primary key references ticket_exception_authority.operations(operation_id) on delete restrict,
  operation_state text not null check (operation_state in (
    'Requested', 'InProgress', 'PartiallyCompleted', 'Completed',
    'FailedRecoverable', 'FailedTerminal'
  )),
  next_required_step text not null,
  last_event_id uuid not null references ticket_exception_authority.operation_events(event_id) on delete restrict,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((operation_state = 'Completed') = (completed_at is not null))
);

create table ticket_exception_authority.financial_evidence (
  evidence_id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references ticket_exception_authority.operations(operation_id) on delete restrict,
  ticket_item_id uuid not null references ticket_authority.ticket_items(ticket_item_id) on delete restrict,
  resettlement_record_id uuid not null references settlement_service.resettlement_records(resettlement_record_id) on delete restrict,
  original_settlement_id uuid not null references settlement_service.authoritative_settlement_records(settlement_id) on delete restrict,
  original_settlement_hash text not null check (original_settlement_hash ~ '^sha256:[0-9a-f]{64}$'),
  reversal_settlement_id uuid not null references settlement_service.authoritative_settlement_records(settlement_id) on delete restrict,
  reversal_settlement_hash text not null check (reversal_settlement_hash ~ '^sha256:[0-9a-f]{64}$'),
  superseding_settlement_id uuid references settlement_service.authoritative_settlement_records(settlement_id) on delete restrict,
  superseding_settlement_hash text check (superseding_settlement_hash is null or superseding_settlement_hash ~ '^sha256:[0-9a-f]{64}$'),
  reversal_ledger_request_id uuid references ledger_service.ledger_posting_requests(id) on delete restrict,
  reversal_ledger_entry_hash text check (reversal_ledger_entry_hash is null or reversal_ledger_entry_hash ~ '^sha256:[0-9a-f]{64}$'),
  reversal_wallet_operation_id uuid references credit_wallet_service.wallet_operation_requests(operation_id) on delete restrict,
  reversal_wallet_result_hash text check (reversal_wallet_result_hash is null or reversal_wallet_result_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_evidence_hash text not null unique check (canonical_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (operation_id, ticket_item_id),
  unique (operation_id, resettlement_record_id),
  check (
    (superseding_settlement_id is null and superseding_settlement_hash is null)
    or (superseding_settlement_id is not null and superseding_settlement_hash is not null)
  )
);

create table ticket_exception_authority.reservation_release_evidence (
  evidence_id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique references ticket_exception_authority.operations(operation_id) on delete restrict,
  reservation_id uuid not null references public.credit_reservations(id) on delete restrict,
  release_id uuid not null unique references public.credit_reservation_releases(id) on delete restrict,
  wallet_operation_id uuid not null unique references credit_wallet_service.wallet_operation_requests(operation_id) on delete restrict,
  released_amount_minor bigint not null check (released_amount_minor > 0),
  canonical_evidence_hash text not null unique check (canonical_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create table ticket_exception_authority.draw_cancellation_impacts (
  impact_id uuid primary key default gen_random_uuid(),
  outcome_lifecycle_event_id uuid not null references game_engine.canonical_outcome_lifecycle_events(lifecycle_event_id) on delete restrict,
  draw_id uuid not null references game_engine.draw_schedules(id) on delete restrict,
  ticket_id uuid not null references ticket_authority.tickets(ticket_id) on delete restrict,
  operation_id uuid references ticket_exception_authority.operations(operation_id) on delete restrict,
  impact_result text not null check (impact_result in (
    'VOIDED', 'REVERSAL_REQUIRED', 'ALREADY_TERMINAL', 'FAILED_RECOVERABLE'
  )),
  canonical_evidence_hash text not null unique check (canonical_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (outcome_lifecycle_event_id, ticket_id)
);

create table compensation.adjustment_requirements (
  adjustment_id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references ticket_exception_authority.operations(operation_id) on delete restrict,
  ticket_id uuid not null references ticket_authority.tickets(ticket_id) on delete restrict,
  strategy text not null check (strategy in ('COMMISSION', 'REBATE')),
  adjustment_action text not null check (adjustment_action in ('REVERSE', 'RECALCULATE')),
  source_completion_id uuid not null references ticket_completion_authority.completion_evidence(completion_id) on delete restrict,
  status text not null default 'ADJUSTMENT_REQUIRED' check (status = 'ADJUSTMENT_REQUIRED'),
  canonical_evidence_hash text not null unique check (canonical_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (operation_id, strategy, adjustment_action)
);

create index idx_ticket_exception_ticket_state
  on ticket_exception_authority.operations(ticket_id, operation_type, requested_at);
create index idx_ticket_exception_projection_recovery
  on ticket_exception_authority.operation_projection(operation_state, updated_at)
  where operation_state in ('Requested', 'InProgress', 'PartiallyCompleted', 'FailedRecoverable');
create index idx_ticket_exception_financial_original
  on ticket_exception_authority.financial_evidence(original_settlement_id, reversal_settlement_id);
create index idx_ticket_exception_draw_impact
  on ticket_exception_authority.draw_cancellation_impacts(draw_id, impact_result);

create or replace function ticket_exception_authority.prevent_immutable_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'Ticket Exception Authority evidence is append-only.';
end;
$$;

do $$
declare v_target record;
begin
  for v_target in select * from (values
    ('ticket_exception_authority','operations'),
    ('ticket_exception_authority','operation_events'),
    ('ticket_exception_authority','financial_evidence'),
    ('ticket_exception_authority','reservation_release_evidence'),
    ('ticket_exception_authority','draw_cancellation_impacts'),
    ('compensation','adjustment_requirements')
  ) as value(schema_name, table_name)
  loop
    execute format(
      'create trigger %I before update or delete on %I.%I for each row execute function ticket_exception_authority.prevent_immutable_mutation()',
      'trg_' || v_target.table_name || '_immutable', v_target.schema_name, v_target.table_name
    );
  end loop;
end;
$$;

create or replace function ticket_exception_authority.guard_projection_mutation()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('ticket_exception_authority.projection_write', true), '') <> 'authorized' then
    raise exception 'Ticket Exception operation projection is controlled by append-only events.';
  end if;
  return new;
end;
$$;

create trigger trg_ticket_exception_projection_guard
before insert or update or delete on ticket_exception_authority.operation_projection
for each row execute function ticket_exception_authority.guard_projection_mutation();

create or replace function ticket_exception_authority.guard_exception_lifecycle_command()
returns trigger language plpgsql as $$
begin
  if new.command_type in ('ReverseSettlement', 'ResettleTicket', 'CancelDraw', 'VoidTicket')
     and coalesce(current_setting('ticket_exception_authority.lifecycle_write', true), '') <> 'authorized' then
    raise exception 'Ticket exception lifecycle commands require Ticket Exception Authority evidence.';
  end if;
  return new;
end;
$$;

create trigger trg_ticket_exception_lifecycle_gate
before insert on ticket_authority.ticket_lifecycle_events
for each row execute function ticket_exception_authority.guard_exception_lifecycle_command();

create or replace function ticket_exception_authority.append_event(
  p_operation_id uuid,
  p_state text,
  p_event_type text,
  p_evidence jsonb,
  p_failure_classification text,
  p_recoverable boolean,
  p_next_required_step text
) returns uuid language plpgsql security definer
set search_path = pg_catalog, ticket_exception_authority, public as $$
declare
  v_sequence integer;
  v_event_id uuid := gen_random_uuid();
  v_hash text;
begin
  select coalesce(max(event_sequence), 0) + 1 into v_sequence
  from ticket_exception_authority.operation_events where operation_id = p_operation_id;
  v_hash := ticket_exception_authority.hash_json(jsonb_build_object(
    'operationId', p_operation_id, 'sequence', v_sequence, 'state', p_state,
    'eventType', p_event_type, 'evidence', coalesce(p_evidence, '{}'::jsonb),
    'failureClassification', p_failure_classification, 'recoverable', p_recoverable
  ));
  insert into ticket_exception_authority.operation_events(
    event_id, operation_id, event_sequence, operation_state, event_type,
    evidence, failure_classification, recoverable, canonical_evidence_hash
  ) values (
    v_event_id, p_operation_id, v_sequence, p_state, p_event_type,
    coalesce(p_evidence, '{}'::jsonb), p_failure_classification, p_recoverable, v_hash
  );
  perform set_config('ticket_exception_authority.projection_write', 'authorized', true);
  insert into ticket_exception_authority.operation_projection(
    operation_id, operation_state, next_required_step, last_event_id, completed_at, updated_at
  ) values (
    p_operation_id, p_state, p_next_required_step, v_event_id,
    case when p_state = 'Completed' then now() else null end, now()
  ) on conflict (operation_id) do update set
    operation_state = excluded.operation_state,
    next_required_step = excluded.next_required_step,
    last_event_id = excluded.last_event_id,
    completed_at = excluded.completed_at,
    updated_at = excluded.updated_at;
  perform set_config('ticket_exception_authority.projection_write', '', true);
  return v_event_id;
end;
$$;

revoke all on function ticket_exception_authority.append_event(uuid,text,text,jsonb,text,boolean,text) from public;

create or replace function ticket_exception_authority.request_operation(
  p_operation_type text,
  p_ticket_id uuid,
  p_expected_lifecycle_version integer,
  p_idempotency_key text,
  p_source_authority text,
  p_source_reference text,
  p_source_hash text,
  p_actor_reference text,
  p_reason_code text,
  p_correlation_id text,
  p_causation_id text default null,
  p_original_completion_id uuid default null,
  p_prior_operation_id uuid default null,
  p_corrected_outcome_version_id uuid default null
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, ticket_exception_authority, ticket_authority,
  ticket_completion_authority, game_engine, public as $$
declare
  v_ticket ticket_authority.tickets%rowtype;
  v_existing ticket_exception_authority.operations%rowtype;
  v_prior ticket_exception_authority.operations%rowtype;
  v_operation_id uuid := gen_random_uuid();
  v_hash text;
begin
  if p_operation_type not in ('VOID','SETTLEMENT_REVERSAL','RESETTLEMENT','DRAW_CANCELLATION') then
    raise exception 'Unsupported ticket exception operation type.';
  end if;
  if nullif(btrim(p_idempotency_key), '') is null or nullif(btrim(p_reason_code), '') is null
     or nullif(btrim(p_actor_reference), '') is null or nullif(btrim(p_correlation_id), '') is null
     or nullif(btrim(p_source_authority), '') is null or nullif(btrim(p_source_reference), '') is null
     or p_source_hash !~ '^sha256:[0-9a-f]{64}$' then
    raise exception 'Ticket exception command evidence is incomplete.';
  end if;
  v_hash := ticket_exception_authority.hash_json(jsonb_build_object(
    'operationType', p_operation_type, 'ticketId', p_ticket_id,
    'expectedLifecycleVersion', p_expected_lifecycle_version,
    'sourceAuthority', p_source_authority, 'sourceReference', p_source_reference,
    'sourceHash', p_source_hash, 'reasonCode', p_reason_code,
    'originalCompletionId', p_original_completion_id,
    'priorOperationId', p_prior_operation_id,
    'correctedOutcomeVersionId', p_corrected_outcome_version_id
  ));
  select * into v_existing from ticket_exception_authority.operations
  where idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_existing.canonical_command_hash <> v_hash then
      raise exception 'Ticket exception idempotency key conflicts with another command.';
    end if;
    return jsonb_build_object(
      'operationId', v_existing.operation_id, 'duplicate', true,
      'state', (select operation_state from ticket_exception_authority.operation_projection where operation_id=v_existing.operation_id),
      'commandHash', v_existing.canonical_command_hash
    );
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ticket-exception:' || p_ticket_id::text, 0));
  select * into v_ticket from ticket_authority.tickets where ticket_id=p_ticket_id for update;
  if not found then raise exception 'Ticket was not found.'; end if;
  if v_ticket.lineage_model <> 'CANONICAL_V1' then
    raise exception 'Legacy ticket history is read-only and cannot enter Ticket Exception Authority.';
  end if;
  if v_ticket.lifecycle_version <> p_expected_lifecycle_version then
    raise exception 'Ticket exception command uses a stale lifecycle version.';
  end if;

  if p_operation_type = 'VOID' then
    if p_source_authority <> 'OPERATIONAL_AUTHORITY' then
      raise exception 'Governed void requires Operational Authority evidence.';
    end if;
    if v_ticket.lifecycle_state not in ('RESERVATION_CREATED','DRAW_CANCELLED') then
      raise exception 'Settled or financially active tickets cannot be directly voided; complete reversal first.';
    end if;
  elsif p_operation_type = 'DRAW_CANCELLATION' then
    if p_source_authority <> 'OUTCOME_LIFECYCLE_AUTHORITY' then
      raise exception 'Draw cancellation requires Outcome Lifecycle Authority evidence.';
    end if;
    if v_ticket.lifecycle_state not in (
      'RESERVATION_CREATED','DRAW_CANCELLED','TICKET_SETTLED',
      'COMMISSION_ELIGIBLE','REBATE_ELIGIBLE','TICKET_RESETTLED'
    ) then raise exception 'Ticket state cannot consume canonical Draw cancellation evidence.'; end if;
    if v_ticket.lifecycle_state not in ('RESERVATION_CREATED','DRAW_CANCELLED') and not exists (
      select 1 from ticket_completion_authority.completion_evidence completion
      where completion.completion_id=p_original_completion_id and completion.ticket_id=p_ticket_id
    ) then raise exception 'Settled Draw cancellation requires exact Ticket Completion evidence.'; end if;
  elsif p_operation_type = 'SETTLEMENT_REVERSAL' then
    if p_source_authority <> 'SETTLEMENT_AUTHORITY' then
      raise exception 'Settlement reversal requires Settlement Authority evidence.';
    end if;
    if v_ticket.lifecycle_state not in ('TICKET_SETTLED','COMMISSION_ELIGIBLE','REBATE_ELIGIBLE','TICKET_RESETTLED') then
      raise exception 'Settlement reversal requires an authoritative settled ticket.';
    end if;
    if not exists (
      select 1 from ticket_completion_authority.completion_evidence completion
      where completion.completion_id=p_original_completion_id and completion.ticket_id=p_ticket_id
        and completion.completion_id::text=p_source_reference
        and completion.canonical_completion_hash=p_source_hash
    ) then raise exception 'Settlement reversal requires exact Ticket Completion evidence.'; end if;
  else
    if v_ticket.lifecycle_state <> 'SETTLEMENT_REVERSED' then
      raise exception 'Resettlement requires completed prior reversal.';
    end if;
    select * into v_prior from ticket_exception_authority.operations where operation_id=p_prior_operation_id;
    if not found or v_prior.ticket_id<>p_ticket_id or v_prior.operation_type<>'SETTLEMENT_REVERSAL'
       or not exists (select 1 from ticket_exception_authority.operation_projection where operation_id=v_prior.operation_id and operation_state='Completed') then
      raise exception 'Resettlement requires the completed canonical reversal operation.';
    end if;
    if p_source_authority <> 'SETTLEMENT_AUTHORITY'
       or p_source_reference <> v_prior.operation_id::text
       or p_source_hash <> (
         select event.canonical_evidence_hash
         from ticket_exception_authority.operation_events event
         where event.operation_id=v_prior.operation_id and event.operation_state='Completed'
         order by event.event_sequence desc limit 1
       )
       or p_original_completion_id <> v_prior.original_completion_id then
      raise exception 'Resettlement source does not match completed canonical reversal evidence.';
    end if;
    if not exists (
      select 1 from game_engine.canonical_outcome_versions outcome
      where outcome.outcome_version_id=p_corrected_outcome_version_id
        and outcome.draw_id=v_ticket.draw_id and outcome.version_kind='Corrected'
    ) then raise exception 'Resettlement requires corrected canonical outcome evidence for the ticket draw.'; end if;
  end if;

  if p_operation_type='DRAW_CANCELLATION' and not exists (
    select 1 from game_engine.canonical_outcome_lifecycle_events event
    where event.lifecycle_event_id=p_source_reference::uuid and event.operation='CANCELLATION'
      and event.draw_id=v_ticket.draw_id and event.evidence_hash=p_source_hash
  ) then raise exception 'Draw cancellation requires exact canonical Outcome cancellation evidence.'; end if;

  if exists (
    select 1 from ticket_exception_authority.operations operation
    join ticket_exception_authority.operation_projection projection using(operation_id)
    where operation.ticket_id=p_ticket_id
      and projection.operation_state in ('Requested','InProgress','PartiallyCompleted','FailedRecoverable')
  ) then raise exception 'Ticket already has an active exception operation.'; end if;

  insert into ticket_exception_authority.operations(
    operation_id, operation_type, ticket_id, expected_lifecycle_version,
    idempotency_key, canonical_command_hash, source_authority, source_reference,
    source_hash, original_completion_id, prior_operation_id, corrected_outcome_version_id,
    actor_reference, reason_code, correlation_id, causation_id
  ) values (
    v_operation_id,p_operation_type,p_ticket_id,p_expected_lifecycle_version,
    btrim(p_idempotency_key),v_hash,btrim(p_source_authority),btrim(p_source_reference),
    p_source_hash,p_original_completion_id,p_prior_operation_id,p_corrected_outcome_version_id,
    btrim(p_actor_reference),btrim(p_reason_code),btrim(p_correlation_id),p_causation_id
  );
  perform ticket_exception_authority.append_event(
    v_operation_id,'Requested','COMMAND_ACCEPTED',jsonb_build_object(
      'ticketId',p_ticket_id,'ticketLifecycleVersion',p_expected_lifecycle_version,
      'sourceReference',p_source_reference,'sourceHash',p_source_hash
    ),null,true,
    case when p_operation_type in ('VOID','DRAW_CANCELLATION') then 'RELEASE_RESERVATION'
         else 'AWAIT_AUTHORITATIVE_FINANCIAL_EVIDENCE' end
  );
  return jsonb_build_object('operationId',v_operation_id,'duplicate',false,'state','Requested','commandHash',v_hash);
end;
$$;

create or replace function ticket_exception_authority.execute_unsettled_void(p_operation_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, ticket_exception_authority, ticket_authority,
  credit_wallet_service, game_engine, public as $$
declare
  v_operation ticket_exception_authority.operations%rowtype;
  v_projection ticket_exception_authority.operation_projection%rowtype;
  v_ticket ticket_authority.tickets%rowtype;
  v_reservation public.credit_reservations%rowtype;
  v_release public.credit_reservation_releases%rowtype;
  v_wallet_request_hash text;
  v_lifecycle jsonb;
begin
  select * into v_operation from ticket_exception_authority.operations where operation_id=p_operation_id;
  if not found or v_operation.operation_type not in ('VOID','DRAW_CANCELLATION') then
    raise exception 'Unsettled void operation was not found.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ticket-exception:' || v_operation.ticket_id::text, 0));
  select * into v_projection from ticket_exception_authority.operation_projection where operation_id=p_operation_id;
  if v_projection.operation_state='Completed' then
    return jsonb_build_object('operationId',p_operation_id,'duplicate',true,'state','Completed');
  end if;
  select * into v_ticket from ticket_authority.tickets where ticket_id=v_operation.ticket_id for update;
  if v_ticket.lifecycle_state not in ('RESERVATION_CREATED','DRAW_CANCELLED') then
    raise exception 'Ticket state no longer permits unsettled void.';
  end if;
  select * into v_reservation from public.credit_reservations where id=v_ticket.reservation_id for update;
  if not found then raise exception 'Ticket reservation was not found.'; end if;

  select release.* into v_release from public.credit_reservation_releases release
  where release.operation_id=p_operation_id;
  if not found then
    if v_reservation.remaining_exposure <= 0 then
      raise exception 'Reservation has no releasable exposure and no canonical release evidence.';
    end if;
    v_wallet_request_hash := ticket_exception_authority.hash_json(jsonb_build_object(
      'operation','CANCEL','ticketId',v_ticket.ticket_id,'reservationId',v_reservation.id,
      'walletId',v_ticket.wallet_id,'instrument',v_ticket.funding_instrument,
      'amountMinor',v_reservation.remaining_exposure,'reasonCode',v_operation.reason_code
    ));
    insert into credit_wallet_service.wallet_operation_requests(
      operation_id,request_id,idempotency_key,canonical_request_hash,operation_type,
      authority,tenant_id,brand_id,player_id,wallet_id,instrument_code,currency,
      amount_minor,ticket_id,reservation_id,reason_code,source_service,effective_at,
      correlation_id,audit_metadata
    ) values (
      p_operation_id,p_operation_id,'ticket-exception:'||v_operation.idempotency_key,
      v_wallet_request_hash,'CANCEL','ticket-exception-authority',v_ticket.tenant_id,
      v_ticket.brand_id,v_ticket.player_account_id,v_ticket.wallet_id,
      v_ticket.funding_instrument,v_ticket.currency,v_reservation.remaining_exposure,
      v_ticket.ticket_id,v_reservation.id,v_operation.reason_code,
      'ticket-exception-authority',now(),v_operation.correlation_id,
      jsonb_build_object('ticketExceptionOperationId',p_operation_id)
    );
    perform credit_wallet_service.cancel_wallet_reservation(
      p_operation_id,v_reservation.id,v_ticket.wallet_id,v_ticket.tenant_id,
      v_ticket.brand_id,v_ticket.player_account_id,v_ticket.funding_instrument,
      v_ticket.ticket_id::text,v_reservation.remaining_exposure,v_ticket.currency,
      'ticket-exception:'||v_operation.idempotency_key,v_operation.correlation_id,
      v_operation.reason_code,jsonb_build_object('ticketExceptionOperationId',p_operation_id)
    );
    select * into v_release from public.credit_reservation_releases where operation_id=p_operation_id;
  end if;
  if v_release.id is null then raise exception 'Reservation release evidence was not created.'; end if;
  insert into ticket_exception_authority.reservation_release_evidence(
    operation_id,reservation_id,release_id,wallet_operation_id,released_amount_minor,canonical_evidence_hash
  ) values (
    p_operation_id,v_reservation.id,v_release.id,p_operation_id,v_release.release_amount,
    ticket_exception_authority.hash_json(jsonb_build_object(
      'operationId',p_operation_id,'reservationId',v_reservation.id,
      'releaseId',v_release.id,'releasedAmountMinor',v_release.release_amount
    ))
  ) on conflict (operation_id) do nothing;
  perform ticket_exception_authority.append_event(
    p_operation_id,'PartiallyCompleted','RESERVATION_RELEASED',
    jsonb_build_object('reservationId',v_reservation.id,'releaseId',v_release.id),
    null,true,'APPEND_TYPED_TICKET_LIFECYCLE'
  );

  perform set_config('ticket_exception_authority.lifecycle_write','authorized',true);
  if v_operation.operation_type='DRAW_CANCELLATION' and v_ticket.lifecycle_state='RESERVATION_CREATED' then
    v_lifecycle := ticket_authority.execute_typed_lifecycle_command(
      'CancelDraw',v_ticket.ticket_id,array['RESERVATION_CREATED'],'DRAW_CANCELLED','AWAITING_DRAW',
      'DRAW_AUTHORITY',v_operation.source_reference,v_operation.source_hash,
      v_operation.idempotency_key||':draw-cancel',v_operation.reason_code,
      v_operation.actor_reference,v_operation.correlation_id,v_operation.causation_id,
      jsonb_build_object('ticketExceptionOperationId',p_operation_id)
    );
    v_ticket.lifecycle_state := 'DRAW_CANCELLED';
  end if;
  v_lifecycle := ticket_authority.execute_typed_lifecycle_command(
    'VoidTicket',v_ticket.ticket_id,array[v_ticket.lifecycle_state],'TICKET_VOIDED','VOIDED',
    'TICKET_EXCEPTION_AUTHORITY',p_operation_id::text,v_operation.canonical_command_hash,
    v_operation.idempotency_key||':ticket-void',v_operation.reason_code,
    v_operation.actor_reference,v_operation.correlation_id,v_operation.causation_id,
    jsonb_build_object('reservationReleaseId',v_release.id,'ticketExceptionOperationId',p_operation_id)
  );
  perform set_config('ticket_exception_authority.lifecycle_write','',true);
  perform ticket_exception_authority.append_event(
    p_operation_id,'Completed','TICKET_VOIDED',
    jsonb_build_object('lifecycleEventId',v_lifecycle->>'eventId','releaseId',v_release.id),
    null,false,'NONE'
  );
  return jsonb_build_object('operationId',p_operation_id,'duplicate',false,'state','Completed','lifecycle',v_lifecycle);
end;
$$;

create or replace function ticket_exception_authority.record_settlement_chain(
  p_operation_id uuid,
  p_resettlement_record_id uuid
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, ticket_exception_authority, ticket_completion_authority,
  ticket_authority, settlement_service, ledger_service, credit_wallet_service, game_engine, public as $$
declare
  v_operation ticket_exception_authority.operations%rowtype;
  v_chain settlement_service.resettlement_records%rowtype;
  v_source ticket_completion_authority.completion_sources%rowtype;
  v_item ticket_authority.ticket_items%rowtype;
  v_reversal settlement_service.authoritative_settlement_records%rowtype;
  v_corrected settlement_service.authoritative_settlement_records%rowtype;
  v_li settlement_service.financial_instructions%rowtype;
  v_wi settlement_service.financial_instructions%rowtype;
  v_la settlement_service.financial_instruction_execution_attempts%rowtype;
  v_wa settlement_service.financial_instruction_execution_attempts%rowtype;
  v_ledger ledger_service.ledger_posting_requests%rowtype;
  v_wallet credit_wallet_service.wallet_operation_requests%rowtype;
  v_wallet_result credit_wallet_service.wallet_operation_terminal_results%rowtype;
  v_existing ticket_exception_authority.financial_evidence%rowtype;
  v_hash text;
begin
  select * into v_operation from ticket_exception_authority.operations where operation_id=p_operation_id;
  if not found or v_operation.operation_type not in ('SETTLEMENT_REVERSAL','RESETTLEMENT','DRAW_CANCELLATION')
     or v_operation.original_completion_id is null then
    raise exception 'Financial ticket exception operation was not found.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ticket-exception:'||v_operation.ticket_id::text,0));
  select * into v_chain from settlement_service.resettlement_records
  where resettlement_record_id=p_resettlement_record_id and lifecycle_state='Completed';
  if not found then raise exception 'Completed authoritative Settlement resettlement chain was not found.'; end if;
  select source.* into v_source
  from ticket_completion_authority.completion_sources source
  join ticket_completion_authority.completion_evidence completion using(request_id)
  where completion.completion_id=v_operation.original_completion_id
    and source.settlement_id=v_chain.original_settlement_id;
  if not found then raise exception 'Resettlement original Settlement is not part of exact Ticket Completion evidence.'; end if;
  select * into v_item from ticket_authority.ticket_items
  where ticket_item_id=v_source.ticket_item_id and ticket_id=v_operation.ticket_id;
  if not found or v_source.settlement_hash<>v_chain.original_settlement_hash then
    raise exception 'Original Settlement does not match exact ticket item Completion evidence.';
  end if;
  select * into v_reversal from settlement_service.authoritative_settlement_records
  where settlement_id=v_chain.reversal_settlement_id and canonical_settlement_hash=v_chain.reversal_settlement_hash
    and ticket_id=v_operation.ticket_id::text and ticket_line_id=v_item.ticket_item_id::text;
  if not found then raise exception 'Reversal Settlement does not bind exact ticket line.'; end if;
  select * into v_li from settlement_service.financial_instructions
  where settlement_id=v_chain.reversal_settlement_id and target_service='ledger-service';
  select * into v_wi from settlement_service.financial_instructions
  where settlement_id=v_chain.reversal_settlement_id and target_service='credit-wallet-service';
  select * into v_la from settlement_service.financial_instruction_execution_attempts
  where instruction_id=v_li.instruction_id and status in ('Posted','Skipped');
  select * into v_wa from settlement_service.financial_instruction_execution_attempts
  where instruction_id=v_wi.instruction_id and status in ('Posted','Skipped');
  if v_la.attempt_id is null or v_wa.attempt_id is null then
    raise exception 'Reversal requires terminal Ledger and Wallet execution evidence.';
  end if;
  if v_la.status='Posted' then
    select * into v_ledger from ledger_service.ledger_posting_requests
    where id=v_la.external_reference_id::uuid and request_kind='REVERSAL' and request_status='COMPLETED'
      and original_ledger_entry_id=v_source.ledger_entry_id;
    if not found then raise exception 'Ledger reversal does not reverse exact original Ledger evidence.'; end if;
  elsif v_li.instruction_type<>'LEDGER_NOOP' then
    raise exception 'Skipped reversal Ledger evidence must be explicit no-op.';
  end if;
  if v_wa.status='Posted' then
    select * into v_wallet from credit_wallet_service.wallet_operation_requests
    where operation_id=v_wa.external_reference_id::uuid and operation_type='REVERSE'
      and settlement_id=v_chain.reversal_settlement_id and ticket_id=v_operation.ticket_id;
    select * into v_wallet_result from credit_wallet_service.wallet_operation_terminal_results
    where operation_id=v_wallet.operation_id and terminal_status='COMMITTED';
    if v_wallet.operation_id is null or v_wallet_result.operation_id is null
       or v_wallet.original_operation_id<>v_source.wallet_operation_id then
      raise exception 'Wallet reversal does not reverse exact original Wallet evidence.';
    end if;
  elsif v_wi.instruction_type<>'CREDIT_NOOP' then
    raise exception 'Skipped reversal Wallet evidence must be explicit no-op.';
  end if;
  if v_operation.operation_type='RESETTLEMENT' then
    select corrected.* into v_corrected
    from settlement_service.authoritative_settlement_records corrected
    join game_engine.canonical_outcome_versions outcome
      on outcome.outcome_certificate_id=corrected.outcome_certificate_id
     and outcome.outcome_certificate_hash=corrected.outcome_certificate_hash
    where corrected.settlement_id=v_chain.corrected_settlement_id
      and corrected.canonical_settlement_hash=v_chain.corrected_settlement_hash
      and corrected.ticket_id=v_operation.ticket_id::text
      and corrected.ticket_line_id=v_item.ticket_item_id::text
      and outcome.outcome_version_id=v_operation.corrected_outcome_version_id;
    if not found then raise exception 'Corrected Settlement does not bind corrected canonical Outcome and ticket line.'; end if;
    if exists (
      select 1 from settlement_service.financial_instructions instruction
      where instruction.settlement_id=v_chain.corrected_settlement_id
        and not exists (select 1 from settlement_service.financial_instruction_execution_attempts attempt
          where attempt.instruction_id=instruction.instruction_id and attempt.status in ('Posted','Skipped'))
    ) then raise exception 'Resettlement corrected financial instructions are incomplete.'; end if;
  end if;
  v_hash := ticket_exception_authority.hash_json(jsonb_build_object(
    'operationId',p_operation_id,'ticketItemId',v_item.ticket_item_id,
    'resettlementRecordId',v_chain.resettlement_record_id,
    'originalSettlementId',v_chain.original_settlement_id,'originalSettlementHash',v_chain.original_settlement_hash,
    'reversalSettlementId',v_chain.reversal_settlement_id,'reversalSettlementHash',v_chain.reversal_settlement_hash,
    'supersedingSettlementId',case when v_operation.operation_type='RESETTLEMENT' then v_chain.corrected_settlement_id else null end,
    'ledgerReversalRequestId',v_ledger.id,'walletReversalOperationId',v_wallet.operation_id
  ));
  select * into v_existing from ticket_exception_authority.financial_evidence
  where operation_id=p_operation_id and ticket_item_id=v_item.ticket_item_id;
  if found then
    if v_existing.canonical_evidence_hash<>v_hash then raise exception 'Ticket exception financial evidence conflict.'; end if;
    return jsonb_build_object('operationId',p_operation_id,'duplicate',true,'evidenceId',v_existing.evidence_id);
  end if;
  insert into ticket_exception_authority.financial_evidence(
    operation_id,ticket_item_id,resettlement_record_id,original_settlement_id,original_settlement_hash,
    reversal_settlement_id,reversal_settlement_hash,superseding_settlement_id,superseding_settlement_hash,
    reversal_ledger_request_id,reversal_ledger_entry_hash,reversal_wallet_operation_id,
    reversal_wallet_result_hash,canonical_evidence_hash
  ) values (
    p_operation_id,v_item.ticket_item_id,v_chain.resettlement_record_id,v_chain.original_settlement_id,
    v_chain.original_settlement_hash,v_chain.reversal_settlement_id,v_chain.reversal_settlement_hash,
    case when v_operation.operation_type='RESETTLEMENT' then v_chain.corrected_settlement_id end,
    case when v_operation.operation_type='RESETTLEMENT' then v_chain.corrected_settlement_hash end,
    v_ledger.id,v_ledger.ledger_entry_hash,v_wallet.operation_id,v_wallet_result.result_hash,v_hash
  ) returning * into v_existing;
  perform ticket_exception_authority.append_event(
    p_operation_id,'PartiallyCompleted','FINANCIAL_CHAIN_VERIFIED',
    jsonb_build_object('ticketItemId',v_item.ticket_item_id,'evidenceId',v_existing.evidence_id,
      'resettlementRecordId',v_chain.resettlement_record_id),null,true,'VERIFY_ALL_TICKET_ITEMS'
  );
  return jsonb_build_object('operationId',p_operation_id,'duplicate',false,'evidenceId',v_existing.evidence_id);
end;
$$;

create or replace function ticket_exception_authority.complete_financial_exception(p_operation_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, ticket_exception_authority, ticket_completion_authority,
  ticket_authority, compensation, public as $$
declare
  v_operation ticket_exception_authority.operations%rowtype;
  v_projection ticket_exception_authority.operation_projection%rowtype;
  v_ticket ticket_authority.tickets%rowtype;
  v_expected integer;
  v_actual integer;
  v_lifecycle jsonb;
  v_action text;
  v_strategy text;
begin
  select * into v_operation from ticket_exception_authority.operations where operation_id=p_operation_id;
  if not found or v_operation.operation_type not in ('SETTLEMENT_REVERSAL','RESETTLEMENT','DRAW_CANCELLATION')
     or v_operation.original_completion_id is null then
    raise exception 'Financial ticket exception operation was not found.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ticket-exception:'||v_operation.ticket_id::text,0));
  select * into v_projection from ticket_exception_authority.operation_projection where operation_id=p_operation_id;
  if v_projection.operation_state='Completed' then
    return jsonb_build_object('operationId',p_operation_id,'duplicate',true,'state','Completed');
  end if;
  select count(*) into v_expected from ticket_completion_authority.completion_sources source
  join ticket_completion_authority.completion_evidence completion using(request_id)
  where completion.completion_id=v_operation.original_completion_id;
  select count(*) into v_actual from ticket_exception_authority.financial_evidence
  where operation_id=p_operation_id;
  if v_expected=0 or v_actual<>v_expected then
    perform ticket_exception_authority.append_event(
      p_operation_id,'FailedRecoverable','FINANCIAL_EVIDENCE_INCOMPLETE',
      jsonb_build_object('expectedItemCount',v_expected,'verifiedItemCount',v_actual),
      'MISSING_AUTHORITATIVE_FINANCIAL_EVIDENCE',true,'VERIFY_ALL_TICKET_ITEMS'
    );
    return jsonb_build_object(
      'operationId',p_operation_id,
      'duplicate',false,
      'state','FailedRecoverable',
      'failureCode','MISSING_AUTHORITATIVE_FINANCIAL_EVIDENCE'
    );
  end if;
  select * into v_ticket from ticket_authority.tickets where ticket_id=v_operation.ticket_id for update;
  perform set_config('ticket_exception_authority.lifecycle_write','authorized',true);
  if v_operation.operation_type in ('SETTLEMENT_REVERSAL','DRAW_CANCELLATION') then
    v_lifecycle := ticket_authority.execute_typed_lifecycle_command(
      'ReverseSettlement',v_ticket.ticket_id,
      array['TICKET_SETTLED','COMMISSION_ELIGIBLE','REBATE_ELIGIBLE','TICKET_RESETTLED'],
      'SETTLEMENT_REVERSED','SETTLED','SETTLEMENT_AUTHORITY',p_operation_id::text,
      v_operation.canonical_command_hash,v_operation.idempotency_key||':lifecycle',
      v_operation.reason_code,v_operation.actor_reference,v_operation.correlation_id,
      v_operation.causation_id,jsonb_build_object('ticketExceptionOperationId',p_operation_id)
    );
    v_action := 'REVERSE';
    if v_operation.operation_type='DRAW_CANCELLATION' then
      v_lifecycle := ticket_authority.execute_typed_lifecycle_command(
        'VoidTicket',v_ticket.ticket_id,array['SETTLEMENT_REVERSED'],
        'TICKET_VOIDED','VOIDED','TICKET_EXCEPTION_AUTHORITY',p_operation_id::text,
        v_operation.canonical_command_hash,v_operation.idempotency_key||':terminal-void',
        v_operation.reason_code,v_operation.actor_reference,v_operation.correlation_id,
        v_operation.causation_id,jsonb_build_object('ticketExceptionOperationId',p_operation_id)
      );
    end if;
  else
    v_lifecycle := ticket_authority.execute_typed_lifecycle_command(
      'ResettleTicket',v_ticket.ticket_id,array['SETTLEMENT_REVERSED'],
      'TICKET_RESETTLED','SETTLED','SETTLEMENT_AUTHORITY',p_operation_id::text,
      v_operation.canonical_command_hash,v_operation.idempotency_key||':lifecycle',
      v_operation.reason_code,v_operation.actor_reference,v_operation.correlation_id,
      v_operation.causation_id,jsonb_build_object(
        'ticketExceptionOperationId',p_operation_id,
        'correctedOutcomeVersionId',v_operation.corrected_outcome_version_id
      )
    );
    v_action := 'RECALCULATE';
  end if;
  perform set_config('ticket_exception_authority.lifecycle_write','',true);
  foreach v_strategy in array array['COMMISSION','REBATE'] loop
    insert into compensation.adjustment_requirements(
      operation_id,ticket_id,strategy,adjustment_action,source_completion_id,canonical_evidence_hash
    ) values (
      p_operation_id,v_operation.ticket_id,v_strategy,v_action,v_operation.original_completion_id,
      ticket_exception_authority.hash_json(jsonb_build_object(
        'operationId',p_operation_id,'ticketId',v_operation.ticket_id,
        'strategy',v_strategy,'action',v_action,'sourceCompletionId',v_operation.original_completion_id
      ))
    ) on conflict (operation_id,strategy,adjustment_action) do nothing;
  end loop;
  perform ticket_exception_authority.append_event(
    p_operation_id,'Completed',
    case v_operation.operation_type
      when 'SETTLEMENT_REVERSAL' then 'SETTLEMENT_REVERSED'
      when 'DRAW_CANCELLATION' then 'DRAW_CANCELLED_AFTER_REVERSAL'
      else 'TICKET_RESETTLED' end,
    jsonb_build_object('lifecycleEventId',v_lifecycle->>'eventId','compensationAdjustmentAction',v_action),
    null,false,'NONE'
  );
  return jsonb_build_object('operationId',p_operation_id,'duplicate',false,'state','Completed','lifecycle',v_lifecycle);
end;
$$;

create or replace function ticket_exception_authority.recover_operation(p_operation_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, ticket_exception_authority, public as $$
declare
  v_operation ticket_exception_authority.operations%rowtype;
  v_projection ticket_exception_authority.operation_projection%rowtype;
begin
  select * into v_operation from ticket_exception_authority.operations where operation_id=p_operation_id;
  if not found then raise exception 'Ticket exception operation was not found.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ticket-exception:'||v_operation.ticket_id::text,0));
  select * into v_projection from ticket_exception_authority.operation_projection where operation_id=p_operation_id;
  if v_projection.operation_state='Completed' then
    return jsonb_build_object('operationId',p_operation_id,'duplicate',true,'state','Completed');
  end if;
  perform ticket_exception_authority.append_event(
    p_operation_id,'InProgress','RECOVERY_INSPECTION_STARTED',
    jsonb_build_object('previousState',v_projection.operation_state,'nextRequiredStep',v_projection.next_required_step),
    null,true,v_projection.next_required_step
  );
  if v_operation.operation_type in ('VOID','DRAW_CANCELLATION') then
    if v_operation.original_completion_id is null then
      return ticket_exception_authority.execute_unsettled_void(p_operation_id);
    end if;
  end if;
  begin
    return ticket_exception_authority.complete_financial_exception(p_operation_id);
  exception when others then
    perform ticket_exception_authority.append_event(
      p_operation_id,'FailedRecoverable','RECOVERY_AWAITING_AUTHORITATIVE_EVIDENCE',
      jsonb_build_object('error',sqlerrm),'AUTHORITATIVE_EVIDENCE_INCOMPLETE',true,'VERIFY_ALL_TICKET_ITEMS'
    );
    return jsonb_build_object('operationId',p_operation_id,'state','FailedRecoverable','error',sqlerrm);
  end;
end;
$$;

create or replace function ticket_exception_authority.process_draw_cancellation(
  p_outcome_lifecycle_event_id uuid,
  p_actor_reference text,
  p_reason_code text,
  p_correlation_id text,
  p_idempotency_prefix text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, ticket_exception_authority, ticket_authority, game_engine, public as $$
declare
  v_source game_engine.canonical_outcome_lifecycle_events%rowtype;
  v_ticket ticket_authority.tickets%rowtype;
  v_request jsonb;
  v_operation_id uuid;
  v_completion_id uuid;
  v_result text;
  v_count integer := 0;
begin
  select * into v_source from game_engine.canonical_outcome_lifecycle_events
  where lifecycle_event_id=p_outcome_lifecycle_event_id and operation='CANCELLATION';
  if not found then raise exception 'Canonical Outcome cancellation evidence was not found.'; end if;
  for v_ticket in select * from ticket_authority.tickets where draw_id=v_source.draw_id order by ticket_id
  loop
    if v_ticket.lifecycle_state in ('TICKET_VOIDED','TICKET_CANCELLED','SETTLEMENT_REVERSED') then
      v_result := 'ALREADY_TERMINAL'; v_operation_id := null;
    else
      select completion_id into v_completion_id
      from ticket_completion_authority.completion_evidence
      where ticket_id=v_ticket.ticket_id;
      v_request := ticket_exception_authority.request_operation(
        'DRAW_CANCELLATION',v_ticket.ticket_id,v_ticket.lifecycle_version,
        p_idempotency_prefix||':'||v_ticket.ticket_id::text,'OUTCOME_LIFECYCLE_AUTHORITY',
        v_source.lifecycle_event_id::text,v_source.evidence_hash,p_actor_reference,p_reason_code,
        p_correlation_id,v_source.causation_id,v_completion_id,null,null
      );
      v_operation_id := (v_request->>'operationId')::uuid;
      if v_ticket.lifecycle_state in ('RESERVATION_CREATED','DRAW_CANCELLED') then
        perform ticket_exception_authority.execute_unsettled_void(v_operation_id);
        v_result := 'VOIDED';
      elsif v_ticket.lifecycle_state in ('TICKET_SETTLED','COMMISSION_ELIGIBLE','REBATE_ELIGIBLE','TICKET_RESETTLED') then
        perform ticket_exception_authority.append_event(
          v_operation_id,'FailedRecoverable','DRAW_CANCELLATION_REVERSAL_REQUIRED',
          jsonb_build_object('drawId',v_source.draw_id,'outcomeLifecycleEventId',v_source.lifecycle_event_id),
          'FINANCIAL_REVERSAL_REQUIRED',true,'CREATE_SETTLEMENT_REVERSAL'
        );
        v_result := 'REVERSAL_REQUIRED';
      else
        perform ticket_exception_authority.append_event(
          v_operation_id,'FailedRecoverable','DRAW_CANCELLATION_STATE_INCOMPLETE',
          jsonb_build_object('ticketLifecycleState',v_ticket.lifecycle_state),
          'TICKET_FINANCIAL_STATE_INCOMPLETE',true,'INSPECT_AUTHORITATIVE_EVIDENCE'
        );
        v_result := 'FAILED_RECOVERABLE';
      end if;
    end if;
    insert into ticket_exception_authority.draw_cancellation_impacts(
      outcome_lifecycle_event_id,draw_id,ticket_id,operation_id,impact_result,canonical_evidence_hash
    ) values (
      v_source.lifecycle_event_id,v_source.draw_id,v_ticket.ticket_id,v_operation_id,v_result,
      ticket_exception_authority.hash_json(jsonb_build_object(
        'outcomeLifecycleEventId',v_source.lifecycle_event_id,'drawId',v_source.draw_id,
        'ticketId',v_ticket.ticket_id,'operationId',v_operation_id,'result',v_result
      ))
    ) on conflict (outcome_lifecycle_event_id,ticket_id) do nothing;
    v_count := v_count + 1;
  end loop;
  return jsonb_build_object('drawId',v_source.draw_id,'affectedTicketCount',v_count);
end;
$$;

create or replace function ticket_exception_authority.readiness()
returns table(check_name text, ready boolean, issue_count bigint)
language sql stable as $$
  select 'single_exception_authority', true, 0::bigint
  union all select 'append_only_commands',
    exists(select 1 from pg_trigger where tgrelid='ticket_exception_authority.operations'::regclass and tgname='trg_operations_immutable'), 0
  union all select 'append_only_events',
    exists(select 1 from pg_trigger where tgrelid='ticket_exception_authority.operation_events'::regclass and tgname='trg_operation_events_immutable'), 0
  union all select 'durable_recovery_projection',
    to_regclass('ticket_exception_authority.operation_projection') is not null, 0
  union all select 'typed_lifecycle_gate',
    exists(select 1 from pg_trigger where tgrelid='ticket_authority.ticket_lifecycle_events'::regclass and tgname='trg_ticket_exception_lifecycle_gate'), 0
  union all select 'financial_evidence_binding',
    to_regclass('ticket_exception_authority.financial_evidence') is not null, 0
  union all select 'compensation_adjustment_binding',
    to_regclass('compensation.adjustment_requirements') is not null, 0
  union all select 'no_active_conflicts', count(*)=0, count(*)
    from (
      select operation.ticket_id
      from ticket_exception_authority.operations operation
      join ticket_exception_authority.operation_projection projection using(operation_id)
      where projection.operation_state in ('Requested','InProgress','PartiallyCompleted','FailedRecoverable')
      group by operation.ticket_id having count(*)>1
    ) conflict;
$$;

comment on schema ticket_exception_authority is
  'Canonical append-only Ticket Exception Authority coordinating void, reversal, resettlement, draw cancellation impact, and evidence-driven recovery.';
comment on table ticket_exception_authority.operation_projection is
  'Mutable current projection derived exclusively from append-only operation_events; it is not audit history.';
comment on table compensation.adjustment_requirements is
  'Append-only Compensation Authority work requirements created by completed ticket reversal or resettlement evidence.';

commit;
