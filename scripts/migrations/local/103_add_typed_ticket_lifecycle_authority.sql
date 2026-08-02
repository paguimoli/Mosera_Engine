begin;

alter table ticket_authority.tickets
  add column lifecycle_state text,
  add column lifecycle_version integer;

update ticket_authority.tickets
set lifecycle_state = case status
    when 'ACCEPTED' then 'ACCEPTED'
    when 'AWAITING_DRAW' then 'RESERVATION_CREATED'
    when 'CLOSED' then 'SETTLEMENT_REQUESTED'
    when 'SETTLEMENT_PENDING' then 'SETTLEMENT_REQUESTED'
    when 'SETTLED' then 'TICKET_SETTLED'
    when 'CANCELLED' then 'TICKET_CANCELLED'
    when 'VOIDED' then 'TICKET_VOIDED'
  end,
  lifecycle_version = case
    when status = 'ACCEPTED' then 1
    else 2
  end;

alter table ticket_authority.tickets
  alter column lifecycle_state set not null,
  alter column lifecycle_state set default 'ACCEPTED',
  alter column lifecycle_version set not null,
  alter column lifecycle_version set default 1,
  add constraint ck_ticket_lifecycle_projection_state check (
    lifecycle_state in (
      'ACCEPTED', 'RESERVATION_CREATED', 'SETTLEMENT_REQUESTED',
      'SETTLEMENT_EXECUTED', 'LEDGER_POSTED', 'WALLET_APPLIED',
      'TICKET_SETTLED', 'COMMISSION_ELIGIBLE', 'REBATE_ELIGIBLE',
      'SETTLEMENT_REVERSED', 'TICKET_RESETTLED', 'DRAW_CANCELLED',
      'TICKET_CANCELLED', 'TICKET_VOIDED'
    )
  ),
  add constraint ck_ticket_lifecycle_projection_version check (lifecycle_version > 0);

alter table ticket_authority.ticket_lifecycle_events
  drop constraint ck_ticket_lifecycle_status,
  add column command_type text,
  add column ticket_version integer,
  add column authority text,
  add column source_reference text,
  add column source_hash text,
  add column idempotency_key text,
  add column canonical_command_hash text,
  add constraint ck_ticket_lifecycle_status check (
    status in (
      'SUBMITTED', 'VALIDATING', 'ACCEPTED', 'AWAITING_DRAW', 'CLOSED',
      'SETTLEMENT_PENDING', 'SETTLED', 'REJECTED', 'CANCELLED', 'VOIDED',
      'REVERSED', 'RESETTLED', 'RESERVATION_CREATED',
      'SETTLEMENT_REQUESTED', 'SETTLEMENT_EXECUTED', 'LEDGER_POSTED',
      'WALLET_APPLIED', 'TICKET_SETTLED', 'COMMISSION_ELIGIBLE',
      'REBATE_ELIGIBLE', 'SETTLEMENT_REVERSED', 'TICKET_RESETTLED',
      'DRAW_CANCELLED', 'TICKET_CANCELLED', 'TICKET_VOIDED'
    )
  ),
  add constraint ck_typed_ticket_lifecycle_evidence check (
    command_type is null or (
      command_type in (
        'AcceptTicket', 'CreateReservation', 'RequestSettlement',
        'ConfirmSettlement', 'PostLedger', 'ApplyWallet', 'MarkSettled',
        'MarkCommissionEligible', 'MarkRebateEligible', 'ReverseSettlement',
        'ResettleTicket', 'CancelDraw', 'CancelTicket', 'VoidTicket'
      )
      and ticket_version > 0
      and btrim(authority) <> ''
      and btrim(source_reference) <> ''
      and source_hash ~ '^sha256:[0-9a-f]{64}$'
      and btrim(idempotency_key) <> ''
      and canonical_command_hash ~ '^sha256:[0-9a-f]{64}$'
    )
  );

insert into ticket_authority.ticket_lifecycle_events (
  event_id, ticket_id, previous_status, status, reason_code,
  actor_reference, correlation_id, causation_id, evidence,
  canonical_event_hash, command_type, ticket_version, authority,
  source_reference, source_hash, idempotency_key, canonical_command_hash
)
select
  gen_random_uuid(),
  ticket.ticket_id,
  null,
  ticket.lifecycle_state,
  'MIGRATION_103_EXISTING_STATE_BOUND',
  'migration-103',
  'migration-103:' || ticket.ticket_id::text,
  null,
  jsonb_build_object('previousCoarseStatus', ticket.status),
  ticket_authority.hash_json(jsonb_build_object(
    'ticketId', ticket.ticket_id,
    'ticketVersion', ticket.lifecycle_version,
    'state', ticket.lifecycle_state,
    'migration', '103'
  )),
  case ticket.lifecycle_state
    when 'ACCEPTED' then 'AcceptTicket'
    when 'RESERVATION_CREATED' then 'CreateReservation'
    when 'SETTLEMENT_REQUESTED' then 'RequestSettlement'
    when 'TICKET_SETTLED' then 'MarkSettled'
    when 'TICKET_CANCELLED' then 'CancelTicket'
    when 'TICKET_VOIDED' then 'VoidTicket'
  end,
  ticket.lifecycle_version,
  'TICKET_AUTHORITY_MIGRATION',
  ticket.ticket_id::text,
  ticket.acceptance_hash,
  'migration-103:' || ticket.ticket_id::text,
  ticket_authority.hash_json(jsonb_build_object(
    'ticketId', ticket.ticket_id,
    'ticketVersion', ticket.lifecycle_version,
    'state', ticket.lifecycle_state,
    'sourceHash', ticket.acceptance_hash,
    'migration', '103'
  ))
from ticket_authority.tickets ticket;

create unique index ux_ticket_lifecycle_command_idempotency
  on ticket_authority.ticket_lifecycle_events(idempotency_key)
  where idempotency_key is not null;
create unique index ux_ticket_lifecycle_ticket_version
  on ticket_authority.ticket_lifecycle_events(ticket_id, ticket_version)
  where command_type is not null;
create index idx_ticket_lifecycle_command_lookup
  on ticket_authority.ticket_lifecycle_events(ticket_id, command_type, created_at);

create or replace function ticket_authority.guard_lifecycle_projection_update()
returns trigger
language plpgsql
as $$
begin
  if row(new.status, new.lifecycle_state, new.lifecycle_version)
     is distinct from row(old.status, old.lifecycle_state, old.lifecycle_version)
     and current_setting('ticket_authority.typed_command', true) <> 'authorized' then
    raise exception 'ticket lifecycle projection is controlled by typed Ticket Lifecycle Authority commands';
  end if;
  return new;
end;
$$;

create trigger tickets_lifecycle_authority_guard
before update on ticket_authority.tickets
for each row execute function ticket_authority.guard_lifecycle_projection_update();

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
  v_ticket ticket_authority.tickets%rowtype;
  v_event_id uuid := gen_random_uuid();
  v_command_type text;
  v_next_state text;
  v_authority text := 'TICKET_AUTHORITY';
  v_source_reference text;
  v_source_hash text;
  v_idempotency_key text;
  v_version integer;
  v_command_payload jsonb;
  v_command_hash text;
  v_event_payload jsonb;
begin
  select * into v_ticket
  from ticket_authority.tickets
  where ticket_id = p_ticket_id
  for update;
  if not found then raise exception 'ticket not found'; end if;

  if p_status = 'ACCEPTED' and p_previous_status is null then
    v_command_type := 'AcceptTicket';
    v_next_state := 'ACCEPTED';
    v_version := 1;
    v_source_reference := v_ticket.ticket_id::text;
    v_source_hash := v_ticket.acceptance_hash;
    v_idempotency_key := 'accept:' || v_ticket.idempotency_key;
  elsif p_status = 'AWAITING_DRAW' and p_previous_status = 'ACCEPTED' then
    v_command_type := 'CreateReservation';
    v_next_state := 'RESERVATION_CREATED';
    v_version := 2;
    v_source_reference := v_ticket.reservation_id::text;
    v_source_hash := ticket_authority.hash_json(jsonb_build_object(
      'ticketId', v_ticket.ticket_id,
      'reservationId', v_ticket.reservation_id,
      'fundingInstrument', v_ticket.funding_instrument,
      'reservationType', v_ticket.reservation_type
    ));
    v_idempotency_key := 'reservation:' || v_ticket.idempotency_key;
  elsif p_status = 'CANCELLED' then
    v_command_type := 'CancelTicket';
    v_next_state := 'TICKET_CANCELLED';
    v_version := v_ticket.lifecycle_version + 1;
    v_source_reference := coalesce(p_evidence->>'releaseId', v_ticket.reservation_id::text);
    v_source_hash := ticket_authority.hash_json(coalesce(p_evidence, '{}'::jsonb));
    v_idempotency_key := 'cancel:' || coalesce(p_causation_id, p_correlation_id);
  else
    raise exception 'generic lifecycle event append is retired; use an explicit Ticket Lifecycle Authority command';
  end if;

  v_command_payload := jsonb_build_object(
    'commandType', v_command_type,
    'ticketId', p_ticket_id,
    'ticketVersion', v_version,
    'previousState', case when v_version = 1 then null else v_ticket.lifecycle_state end,
    'nextState', v_next_state,
    'authority', v_authority,
    'sourceReference', v_source_reference,
    'sourceHash', v_source_hash,
    'reasonCode', p_reason_code,
    'actorReference', coalesce(nullif(btrim(p_actor_reference), ''), 'system'),
    'correlationId', p_correlation_id,
    'causationId', p_causation_id,
    'evidence', coalesce(p_evidence, '{}'::jsonb)
  );
  v_command_hash := ticket_authority.hash_json(v_command_payload);
  v_event_payload := v_command_payload || jsonb_build_object('eventId', v_event_id);

  insert into ticket_authority.ticket_lifecycle_events (
    event_id, ticket_id, previous_status, status, reason_code,
    actor_reference, correlation_id, causation_id, evidence,
    canonical_event_hash, command_type, ticket_version, authority,
    source_reference, source_hash, idempotency_key, canonical_command_hash
  ) values (
    v_event_id, p_ticket_id,
    case when v_version = 1 then null else v_ticket.lifecycle_state end,
    v_next_state, p_reason_code,
    coalesce(nullif(btrim(p_actor_reference), ''), 'system'),
    p_correlation_id, p_causation_id, coalesce(p_evidence, '{}'::jsonb),
    ticket_authority.hash_json(v_event_payload), v_command_type, v_version,
    v_authority, v_source_reference, v_source_hash, v_idempotency_key,
    v_command_hash
  );

  perform set_config('ticket_authority.typed_command', 'authorized', true);
  update ticket_authority.tickets
  set lifecycle_state = v_next_state,
      lifecycle_version = v_version
  where ticket_id = p_ticket_id;
  perform set_config('ticket_authority.typed_command', '', true);
  return v_event_id;
end;
$$;

create or replace function ticket_authority.execute_typed_lifecycle_command(
  p_command_type text,
  p_ticket_id uuid,
  p_expected_states text[],
  p_next_state text,
  p_projected_status text,
  p_authority text,
  p_source_reference text,
  p_source_hash text,
  p_idempotency_key text,
  p_reason_code text,
  p_actor_reference text,
  p_correlation_id text,
  p_causation_id text,
  p_evidence jsonb
)
returns jsonb
language plpgsql
as $$
declare
  v_ticket ticket_authority.tickets%rowtype;
  v_existing ticket_authority.ticket_lifecycle_events%rowtype;
  v_event_id uuid := gen_random_uuid();
  v_version integer;
  v_payload jsonb;
  v_hash text;
  v_correlation_type text;
  v_operation_kind text;
begin
  if nullif(btrim(p_source_reference), '') is null then
    raise exception 'authoritative source reference is required';
  end if;
  if p_source_hash !~ '^sha256:[0-9a-f]{64}$' then
    raise exception 'authoritative source hash is invalid';
  end if;
  if nullif(btrim(p_idempotency_key), '') is null then
    raise exception 'lifecycle idempotency key is required';
  end if;
  if nullif(btrim(p_correlation_id), '') is null then
    raise exception 'lifecycle correlation id is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_ticket_id::text, 0));
  select * into v_ticket
  from ticket_authority.tickets
  where ticket_id = p_ticket_id
  for update;
  if not found then raise exception 'ticket not found'; end if;

  v_version := v_ticket.lifecycle_version + 1;
  v_payload := jsonb_build_object(
    'commandType', p_command_type,
    'ticketId', p_ticket_id,
    'ticketVersion', v_version,
    'previousState', v_ticket.lifecycle_state,
    'nextState', p_next_state,
    'authority', p_authority,
    'sourceReference', btrim(p_source_reference),
    'sourceHash', p_source_hash,
    'reasonCode', p_reason_code,
    'actorReference', p_actor_reference,
    'correlationId', p_correlation_id,
    'causationId', p_causation_id,
    'evidence', coalesce(p_evidence, '{}'::jsonb)
  );
  v_hash := ticket_authority.hash_json(v_payload);

  select * into v_existing
  from ticket_authority.ticket_lifecycle_events
  where idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_existing.ticket_id <> p_ticket_id
       or v_existing.command_type <> p_command_type
       or v_existing.source_reference <> btrim(p_source_reference)
       or v_existing.source_hash <> p_source_hash
       or v_existing.reason_code <> p_reason_code
       or v_existing.evidence <> coalesce(p_evidence, '{}'::jsonb) then
      raise exception 'ticket lifecycle idempotency key conflicts with existing command evidence';
    end if;
    return jsonb_build_object(
      'applied', true,
      'duplicate', true,
      'eventId', v_existing.event_id,
      'ticketId', p_ticket_id,
      'lifecycleState', v_existing.status,
      'ticketVersion', v_existing.ticket_version,
      'commandHash', v_existing.canonical_command_hash
    );
  end if;

  if not (v_ticket.lifecycle_state = any(p_expected_states)) then
    raise exception 'ticket lifecycle command % is invalid from state %',
      p_command_type, v_ticket.lifecycle_state;
  end if;

  insert into ticket_authority.ticket_lifecycle_events (
    event_id, ticket_id, previous_status, status, reason_code,
    actor_reference, correlation_id, causation_id, evidence,
    canonical_event_hash, command_type, ticket_version, authority,
    source_reference, source_hash, idempotency_key, canonical_command_hash
  ) values (
    v_event_id, p_ticket_id, v_ticket.lifecycle_state, p_next_state,
    p_reason_code, p_actor_reference, p_correlation_id, p_causation_id,
    coalesce(p_evidence, '{}'::jsonb),
    ticket_authority.hash_json(v_payload || jsonb_build_object('eventId', v_event_id)),
    p_command_type, v_version, p_authority, btrim(p_source_reference),
    p_source_hash, btrim(p_idempotency_key), v_hash
  );

  v_correlation_type := case p_command_type
    when 'RequestSettlement' then 'OUTCOME'
    when 'ConfirmSettlement' then 'SETTLEMENT'
    when 'PostLedger' then 'LEDGER_ENTRY'
    when 'ApplyWallet' then 'WALLET_OPERATION'
    when 'ReverseSettlement' then 'REVERSAL'
    when 'ResettleTicket' then 'RESETTLEMENT'
    when 'CancelDraw' then 'DRAW_VOID'
    else null
  end;
  v_operation_kind := upper(regexp_replace(p_command_type, '([a-z])([A-Z])', '\1_\2', 'g'));
  if v_correlation_type is not null then
    insert into ticket_authority.ticket_correlations (
      ticket_id, correlation_type, source_id, source_hash, operation_kind,
      evidence, correlation_id, canonical_correlation_hash
    ) values (
      p_ticket_id, v_correlation_type, btrim(p_source_reference), p_source_hash,
      v_operation_kind, coalesce(p_evidence, '{}'::jsonb), p_correlation_id,
      ticket_authority.hash_json(jsonb_build_object(
        'ticketId', p_ticket_id,
        'commandType', p_command_type,
        'sourceId', btrim(p_source_reference),
        'sourceHash', p_source_hash,
        'evidence', coalesce(p_evidence, '{}'::jsonb)
      ))
    );
  end if;

  perform set_config('ticket_authority.typed_command', 'authorized', true);
  update ticket_authority.tickets
  set lifecycle_state = p_next_state,
      lifecycle_version = v_version,
      status = p_projected_status
  where ticket_id = p_ticket_id;
  perform set_config('ticket_authority.typed_command', '', true);

  return jsonb_build_object(
    'applied', true,
    'duplicate', false,
    'eventId', v_event_id,
    'ticketId', p_ticket_id,
    'lifecycleState', p_next_state,
    'ticketVersion', v_version,
    'commandHash', v_hash
  );
end;
$$;

revoke all on function ticket_authority.execute_typed_lifecycle_command(
  text,uuid,text[],text,text,text,text,text,text,text,text,text,text,jsonb
) from public;

do $$
declare
  v_command record;
begin
  for v_command in
    select * from (values
      ('request_settlement','RequestSettlement',array['RESERVATION_CREATED']::text[],'SETTLEMENT_REQUESTED','SETTLEMENT_PENDING','OUTCOME_AUTHORITY'),
      ('confirm_settlement','ConfirmSettlement',array['SETTLEMENT_REQUESTED']::text[],'SETTLEMENT_EXECUTED','SETTLEMENT_PENDING','SETTLEMENT_AUTHORITY'),
      ('post_ledger','PostLedger',array['SETTLEMENT_EXECUTED']::text[],'LEDGER_POSTED','SETTLEMENT_PENDING','LEDGER_AUTHORITY'),
      ('apply_wallet','ApplyWallet',array['LEDGER_POSTED']::text[],'WALLET_APPLIED','SETTLEMENT_PENDING','CREDIT_WALLET_AUTHORITY'),
      ('mark_settled','MarkSettled',array['WALLET_APPLIED']::text[],'TICKET_SETTLED','SETTLED','SETTLEMENT_AUTHORITY'),
      ('mark_commission_eligible','MarkCommissionEligible',array['TICKET_SETTLED']::text[],'COMMISSION_ELIGIBLE','SETTLED','COMPENSATION_AUTHORITY'),
      ('mark_rebate_eligible','MarkRebateEligible',array['COMMISSION_ELIGIBLE']::text[],'REBATE_ELIGIBLE','SETTLED','COMPENSATION_AUTHORITY'),
      ('reverse_settlement','ReverseSettlement',array['TICKET_SETTLED','COMMISSION_ELIGIBLE','REBATE_ELIGIBLE','TICKET_RESETTLED']::text[],'SETTLEMENT_REVERSED','SETTLED','SETTLEMENT_AUTHORITY'),
      ('resettle_ticket','ResettleTicket',array['SETTLEMENT_REVERSED']::text[],'TICKET_RESETTLED','SETTLED','SETTLEMENT_AUTHORITY'),
      ('cancel_draw','CancelDraw',array['RESERVATION_CREATED']::text[],'DRAW_CANCELLED','AWAITING_DRAW','DRAW_AUTHORITY'),
      ('void_ticket','VoidTicket',array['RESERVATION_CREATED','SETTLEMENT_REQUESTED','SETTLEMENT_EXECUTED','LEDGER_POSTED','WALLET_APPLIED','TICKET_SETTLED','COMMISSION_ELIGIBLE','REBATE_ELIGIBLE','SETTLEMENT_REVERSED','TICKET_RESETTLED','DRAW_CANCELLED']::text[],'TICKET_VOIDED','VOIDED','OPERATIONAL_AUTHORITY')
    ) as command(function_name, command_type, expected_states, next_state, projected_status, authority)
  loop
    execute format($function$
      create or replace function ticket_authority.%I(
        p_ticket_id uuid,
        p_source_reference text,
        p_source_hash text,
        p_idempotency_key text,
        p_reason_code text,
        p_actor_reference text,
        p_correlation_id text,
        p_causation_id text,
        p_evidence jsonb default '{}'::jsonb
      ) returns jsonb language sql security definer
        set search_path = pg_catalog, ticket_authority, public as $body$
        select ticket_authority.execute_typed_lifecycle_command(
          %L, p_ticket_id, %L::text[], %L, %L, %L,
          p_source_reference, p_source_hash, p_idempotency_key, p_reason_code,
          p_actor_reference, p_correlation_id, p_causation_id, p_evidence
        )
      $body$;
    $function$,
      v_command.function_name,
      v_command.command_type,
      v_command.expected_states,
      v_command.next_state,
      v_command.projected_status,
      v_command.authority
    );
  end loop;
end;
$$;

do $$
declare
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(
    'ticket_authority.cancel_ticket(uuid,text,text,text,text)'::regprocedure
  ) into v_definition;
  v_updated := replace(
    v_definition,
    E'  update ticket_authority.tickets\n  set status = ''CANCELLED''',
    E'  perform set_config(''ticket_authority.typed_command'', ''authorized'', true);\n  update ticket_authority.tickets\n  set status = ''CANCELLED'''
  );
  if v_updated = v_definition then
    raise exception 'typed Ticket Lifecycle Authority could not bind cancellation projection';
  end if;
  execute v_updated;
end;
$$;

drop function ticket_authority.record_correlation(uuid,uuid,text,text,text,text,jsonb,text);

create or replace function ticket_authority.cancel_ticket_after_draw(
  p_ticket_id uuid,
  p_source_reference text,
  p_source_hash text,
  p_idempotency_key text,
  p_reason_code text,
  p_actor_reference text,
  p_correlation_id text,
  p_causation_id text,
  p_evidence jsonb default '{}'::jsonb
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, ticket_authority, public
as $$
  select ticket_authority.execute_typed_lifecycle_command(
    'CancelTicket', p_ticket_id, array['DRAW_CANCELLED']::text[],
    'TICKET_CANCELLED', 'CANCELLED', 'TICKET_AUTHORITY',
    p_source_reference, p_source_hash, p_idempotency_key, p_reason_code,
    p_actor_reference, p_correlation_id, p_causation_id, p_evidence
  )
$$;

do $$
declare
  v_identity regprocedure := 'ticket_authority.ticket_readiness()'::regprocedure;
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(v_identity) into v_definition;
  v_updated := replace(
    v_definition,
    E'    union all\n    select ''legacy_production_routes_disabled'', true, 0::bigint',
    E'    union all\n    select ''typed_lifecycle_authority'',\n      count(*) = 0, count(*)\n    from ticket_authority.tickets ticket\n    where not exists (\n      select 1 from ticket_authority.ticket_lifecycle_events event\n      where event.ticket_id = ticket.ticket_id\n        and event.command_type is not null\n        and event.ticket_version = ticket.lifecycle_version\n        and event.status = ticket.lifecycle_state\n    )\n    union all\n    select ''legacy_generic_lifecycle_mutation_retired'',\n      to_regprocedure(''ticket_authority.record_correlation(uuid,uuid,text,text,text,text,jsonb,text)'') is null,\n      case when to_regprocedure(''ticket_authority.record_correlation(uuid,uuid,text,text,text,text,jsonb,text)'') is null then 0 else 1 end::bigint\n    union all\n    select ''legacy_production_routes_disabled'', true, 0::bigint'
  );
  if v_updated = v_definition then
    raise exception 'typed Ticket Lifecycle Authority could not extend readiness';
  end if;
  execute v_updated;
end;
$$;

comment on column ticket_authority.tickets.lifecycle_state is
  'Current projection of the append-only typed Ticket Lifecycle Authority command stream.';
comment on function ticket_authority.execute_typed_lifecycle_command(
  text,uuid,text[],text,text,text,text,text,text,text,text,text,text,jsonb
) is
  'Private implementation used only by explicit typed lifecycle command functions; PUBLIC execution is revoked.';

commit;
