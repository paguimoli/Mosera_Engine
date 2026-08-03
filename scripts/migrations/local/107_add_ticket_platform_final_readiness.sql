begin;

create or replace function ticket_authority.bind_settlement_request_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, ticket_authority, settlement_service, public
as $$
declare
  v_ticket ticket_authority.tickets%rowtype;
  v_idempotency_key text;
begin
  if new.ticket_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return new;
  end if;

  select * into v_ticket
  from ticket_authority.tickets
  where ticket_id = new.ticket_id::uuid
    and lineage_model = 'CANONICAL_V1'
  for update;

  if v_ticket.ticket_id is null then
    return new;
  end if;

  v_idempotency_key := format(
    'canonical-settlement-request:%s:%s',
    v_ticket.ticket_id,
    new.outcome_certificate_id
  );

  if v_ticket.lifecycle_state = 'RESERVATION_CREATED' then
    perform ticket_authority.request_settlement(
      v_ticket.ticket_id,
      new.outcome_certificate_id::text,
      new.outcome_certificate_hash,
      v_idempotency_key,
      'CERTIFIED_OUTCOME_SETTLEMENT_INPUT',
      'settlement-service',
      new.settlement_request_id::text,
      new.settlement_input_id::text,
      jsonb_build_object(
        'outcomeCertificateId', new.outcome_certificate_id,
        'outcomeCertificateHash', new.outcome_certificate_hash
      )
    );
  elsif v_ticket.lifecycle_state not in (
    'SETTLEMENT_REQUESTED', 'SETTLEMENT_EXECUTED', 'LEDGER_POSTED',
    'WALLET_APPLIED', 'TICKET_SETTLED', 'COMMISSION_ELIGIBLE',
    'REBATE_ELIGIBLE', 'SETTLEMENT_REVERSED', 'TICKET_RESETTLED'
  ) then
    raise exception 'Canonical ticket state % does not permit SettlementInput ingestion.',
      v_ticket.lifecycle_state;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_bind_ticket_settlement_request
  on settlement_service.settlement_requests;
create trigger trg_bind_ticket_settlement_request
before insert on settlement_service.settlement_requests
for each row execute function ticket_authority.bind_settlement_request_lifecycle();

-- Existing accepted SettlementInput evidence is authoritative enough to append the
-- missing typed transition. No historical row is edited.
do $$
declare
  v_request record;
begin
  for v_request in
    select distinct on (ticket.ticket_id)
      ticket.ticket_id,
      request.settlement_request_id,
      request.settlement_input_id,
      request.outcome_certificate_id,
      request.outcome_certificate_hash
    from ticket_authority.tickets ticket
    join settlement_service.settlement_requests request
      on request.ticket_id = ticket.ticket_id::text
    where ticket.lineage_model = 'CANONICAL_V1'
      and ticket.lifecycle_state = 'RESERVATION_CREATED'
      and request.status = 'Accepted'
    order by ticket.ticket_id, request.created_at, request.settlement_request_id
  loop
    perform ticket_authority.request_settlement(
      v_request.ticket_id,
      v_request.outcome_certificate_id::text,
      v_request.outcome_certificate_hash,
      format('canonical-settlement-request:%s:%s',
        v_request.ticket_id, v_request.outcome_certificate_id),
      'CERTIFIED_OUTCOME_SETTLEMENT_INPUT',
      'settlement-service',
      v_request.settlement_request_id::text,
      v_request.settlement_input_id::text,
      jsonb_build_object(
        'outcomeCertificateId', v_request.outcome_certificate_id,
        'outcomeCertificateHash', v_request.outcome_certificate_hash
      )
    );
  end loop;
end;
$$;

create or replace function ticket_authority.ticket_platform_readiness()
returns table(check_name text, ready boolean, issue_count bigint)
language sql
stable
as $$
  with base as materialized (
    select * from ticket_authority.ticket_readiness()
  ),
  referential as materialized (
    select * from ticket_authority.ticket_referential_integrity_readiness()
  ),
  exceptions as materialized (
    select * from ticket_exception_authority.readiness()
  ),
  checks as (
    select 'acceptance_authority'::text as check_name,
      to_regprocedure('ticket_authority.accept_ticket(uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,text,text,text)') is not null
        and coalesce((select bool_and(ready) from base), false) as ready,
      coalesce((select sum(issue_count) from base), 1)::bigint as issue_count
    union all
    select 'effective_availability_authority',
      to_regprocedure('ticket_authority.resolve_effective_availability(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz)') is not null
        and to_regclass('ticket_authority.availability_decisions') is not null,
      case when to_regprocedure('ticket_authority.resolve_effective_availability(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,timestamptz)') is not null
        and to_regclass('ticket_authority.availability_decisions') is not null then 0 else 1 end
    union all
    select 'liability_authority',
      to_regprocedure('ticket_authority.evaluate_liability(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,text,timestamptz)') is not null
        and to_regclass('ticket_authority.liability_decisions') is not null,
      case when to_regprocedure('ticket_authority.evaluate_liability(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,text,timestamptz)') is not null
        and to_regclass('ticket_authority.liability_decisions') is not null then 0 else 1 end
    union all
    select 'reservation_and_funding_authority',
      coalesce((select ready from referential where check_name='canonical_wallet_reservation_lineage'), false),
      coalesce((select issue_count from referential where check_name='canonical_wallet_reservation_lineage'), 1)
    union all
    select 'settlement_ingestion_lifecycle_gate',
      exists(select 1 from pg_trigger where tgrelid='settlement_service.settlement_requests'::regclass
        and tgname='trg_bind_ticket_settlement_request' and tgenabled <> 'D')
      and count(*)=0,
      count(*)
    from settlement_service.settlement_requests request
    join ticket_authority.tickets ticket on ticket.ticket_id::text=request.ticket_id
    where ticket.lineage_model='CANONICAL_V1'
      and ticket.lifecycle_state='RESERVATION_CREATED'
      and request.status='Accepted'
    union all
    select 'financial_completion_authority',
      to_regprocedure('ticket_completion_authority.complete_ticket(uuid,jsonb,text,text,text,text)') is not null
        and to_regclass('ticket_completion_authority.completion_evidence') is not null,
      case when to_regprocedure('ticket_completion_authority.complete_ticket(uuid,jsonb,text,text,text,text)') is not null
        and to_regclass('ticket_completion_authority.completion_evidence') is not null then 0 else 1 end
    union all
    select 'ledger_wallet_completion_evidence', count(*)=0, count(*)
    from ticket_completion_authority.completion_evidence evidence
    where not exists (
      select 1 from ticket_completion_authority.completion_sources source
      where source.request_id=evidence.request_id
        and source.ledger_execution_attempt_id is not null
        and source.wallet_execution_attempt_id is not null
    )
    union all
    select 'typed_lifecycle_authority',
      coalesce((select ready from base where check_name='typed_lifecycle_authority'), false),
      coalesce((select issue_count from base where check_name='typed_lifecycle_authority'), 1)
    union all
    select 'replay_and_recovery_authority',
      to_regclass('ticket_authority.ticket_recovery_events') is not null
        and to_regclass('ticket_exception_authority.operation_events') is not null,
      case when to_regclass('ticket_authority.ticket_recovery_events') is not null
        and to_regclass('ticket_exception_authority.operation_events') is not null then 0 else 1 end
    union all
    select 'exception_authority', coalesce(bool_and(ready), false), coalesce(sum(issue_count), 1)::bigint
    from exceptions
    union all
    select 'compensation_handoff',
      to_regclass('compensation.adjustment_requirements') is not null,
      case when to_regclass('compensation.adjustment_requirements') is not null then 0 else 1 end
    union all
    select 'draw_outcome_lineage',
      coalesce((select ready from referential where check_name='canonical_execution_manifest_lineage'), false),
      coalesce((select issue_count from referential where check_name='canonical_execution_manifest_lineage'), 1)
    union all
    select 'hierarchy_and_scope_binding',
      coalesce((select ready from base where check_name='canonical_scope_binding'), false),
      coalesce((select issue_count from base where check_name='canonical_scope_binding'), 1)
    union all
    select 'referential_integrity', coalesce(bool_and(ready), false), coalesce(sum(issue_count), 1)::bigint
    from referential
    union all
    select 'legacy_mutation_paths_retired',
      coalesce((select ready from base where check_name='legacy_generic_lifecycle_mutation_retired'), false)
        and coalesce((select ready from base where check_name='legacy_production_routes_disabled'), false),
      coalesce((select sum(issue_count) from base
        where check_name in ('legacy_generic_lifecycle_mutation_retired','legacy_production_routes_disabled')), 1)::bigint
  )
  select checks.check_name, checks.ready, checks.issue_count from checks
  order by checks.check_name;
$$;

comment on function ticket_authority.ticket_platform_readiness() is
  'Sole BF-5.7 aggregate readiness evaluation for the production Ticket Platform authority chain.';
comment on function ticket_authority.bind_settlement_request_lifecycle() is
  'Atomically binds accepted canonical SettlementInput ingestion to typed Ticket lifecycle evidence.';

commit;
