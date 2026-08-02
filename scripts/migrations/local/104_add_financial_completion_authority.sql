create schema if not exists ticket_completion_authority;

create or replace function ticket_completion_authority.hash_json(p_value jsonb)
returns text language sql immutable strict as $$
  select 'sha256:' || encode(digest(convert_to(p_value::text, 'UTF8'), 'sha256'), 'hex')
$$;

create table ticket_completion_authority.completion_requests (
  request_id uuid primary key,
  ticket_id uuid not null unique references ticket_authority.tickets(ticket_id),
  idempotency_key text not null unique,
  canonical_request_hash text not null unique check (canonical_request_hash ~ '^sha256:[0-9a-f]{64}$'),
  source_count integer not null check (source_count > 0),
  actor_reference text not null,
  correlation_id text not null,
  causation_id text,
  requested_at timestamptz not null default now()
);

create table ticket_completion_authority.completion_sources (
  source_id uuid primary key,
  request_id uuid not null references ticket_completion_authority.completion_requests(request_id),
  ticket_item_id uuid not null references ticket_authority.ticket_items(ticket_item_id),
  settlement_id uuid not null unique references settlement_service.authoritative_settlement_records(settlement_id),
  settlement_hash text not null check (settlement_hash ~ '^sha256:[0-9a-f]{64}$'),
  ledger_execution_attempt_id uuid not null unique references settlement_service.financial_instruction_execution_attempts(attempt_id),
  ledger_posting_request_id uuid unique references ledger_service.ledger_posting_requests(id),
  ledger_entry_id uuid unique references public.financial_ledger_entries(id),
  ledger_entry_hash text check (ledger_entry_hash is null or ledger_entry_hash ~ '^sha256:[0-9a-f]{64}$'),
  wallet_execution_attempt_id uuid not null unique references settlement_service.financial_instruction_execution_attempts(attempt_id),
  wallet_operation_id uuid unique references credit_wallet_service.wallet_operation_requests(operation_id),
  wallet_result_hash text check (wallet_result_hash is null or wallet_result_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_source_hash text not null unique check (canonical_source_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (request_id, ticket_item_id),
  check (
    (ledger_posting_request_id is null and ledger_entry_id is null and ledger_entry_hash is null)
    or
    (ledger_posting_request_id is not null and ledger_entry_id is not null and ledger_entry_hash is not null)
  ),
  check (
    (wallet_operation_id is null and wallet_result_hash is null)
    or
    (wallet_operation_id is not null and wallet_result_hash is not null)
  )
);

create table ticket_completion_authority.completion_attempts (
  attempt_id uuid primary key,
  request_id uuid not null references ticket_completion_authority.completion_requests(request_id),
  attempt_number integer not null check (attempt_number > 0),
  result text not null check (result in ('COMPLETED', 'REUSED')),
  evidence_hash text not null unique check (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (request_id, attempt_number)
);

create table ticket_completion_authority.completion_evidence (
  completion_id uuid primary key,
  request_id uuid not null unique references ticket_completion_authority.completion_requests(request_id),
  ticket_id uuid not null unique references ticket_authority.tickets(ticket_id),
  source_count integer not null check (source_count > 0),
  lifecycle_terminal_event_id uuid not null references ticket_authority.ticket_lifecycle_events(event_id),
  canonical_completion_hash text not null unique check (canonical_completion_hash ~ '^sha256:[0-9a-f]{64}$'),
  completed_at timestamptz not null default now()
);

create index idx_completion_sources_request
  on ticket_completion_authority.completion_sources(request_id, ticket_item_id);
create index idx_completion_attempts_request
  on ticket_completion_authority.completion_attempts(request_id, attempt_number);

create or replace function ticket_completion_authority.prevent_evidence_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'Financial completion evidence is append-only; append recovery evidence instead.';
end;
$$;

do $$
declare v_table text;
begin
  foreach v_table in array array[
    'completion_requests', 'completion_sources', 'completion_attempts', 'completion_evidence'
  ] loop
    execute format(
      'create trigger %I before update or delete on ticket_completion_authority.%I
       for each row execute function ticket_completion_authority.prevent_evidence_mutation()',
      'trg_' || v_table || '_immutable', v_table
    );
  end loop;
end;
$$;

create or replace function ticket_completion_authority.complete_ticket(
  p_ticket_id uuid,
  p_sources jsonb,
  p_idempotency_key text,
  p_actor_reference text,
  p_correlation_id text,
  p_causation_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, ticket_completion_authority, ticket_authority,
  settlement_service, ledger_service, credit_wallet_service, public
as $$
declare
  v_ticket ticket_authority.tickets%rowtype;
  v_ticket_item ticket_authority.ticket_items%rowtype;
  v_settlement settlement_service.authoritative_settlement_records%rowtype;
  v_ledger_attempt settlement_service.financial_instruction_execution_attempts%rowtype;
  v_wallet_attempt settlement_service.financial_instruction_execution_attempts%rowtype;
  v_ledger_instruction settlement_service.financial_instructions%rowtype;
  v_wallet_instruction settlement_service.financial_instructions%rowtype;
  v_ledger ledger_service.ledger_posting_requests%rowtype;
  v_wallet credit_wallet_service.wallet_operation_requests%rowtype;
  v_wallet_result credit_wallet_service.wallet_operation_terminal_results%rowtype;
  v_request ticket_completion_authority.completion_requests%rowtype;
  v_existing ticket_completion_authority.completion_evidence%rowtype;
  v_source jsonb;
  v_sources jsonb;
  v_source_hashes jsonb;
  v_ticket_item_id uuid;
  v_settlement_id uuid;
  v_ledger_attempt_id uuid;
  v_wallet_attempt_id uuid;
  v_ledger_request_id uuid;
  v_wallet_operation_id uuid;
  v_request_id uuid := gen_random_uuid();
  v_completion_id uuid := gen_random_uuid();
  v_terminal_event_id uuid;
  v_request_hash text;
  v_completion_hash text;
  v_attempt_number integer;
  v_item_count integer;
  v_source_count integer;
  v_result jsonb;
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'Financial completion idempotency key is required.';
  end if;
  if p_actor_reference is null or btrim(p_actor_reference) = '' then
    raise exception 'Financial completion actor reference is required.';
  end if;
  if p_correlation_id is null or btrim(p_correlation_id) = '' then
    raise exception 'Financial completion correlation id is required.';
  end if;
  if jsonb_typeof(p_sources) <> 'array' or jsonb_array_length(p_sources) = 0 then
    raise exception 'Financial completion requires per-item authoritative source evidence.';
  end if;

  select jsonb_agg(value order by value->>'settlementId') into v_sources
  from jsonb_array_elements(p_sources);
  v_source_count := jsonb_array_length(v_sources);
  v_request_hash := ticket_completion_authority.hash_json(jsonb_build_object(
    'ticketId', p_ticket_id, 'sources', v_sources
  ));

  perform pg_advisory_xact_lock(hashtextextended('ticket-completion:' || p_ticket_id::text, 0));
  select * into v_ticket from ticket_authority.tickets where ticket_id = p_ticket_id for update;
  if not found then raise exception 'Ticket was not found.'; end if;

  select * into v_request
  from ticket_completion_authority.completion_requests
  where idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_request.canonical_request_hash <> v_request_hash then
      raise exception 'Financial completion idempotency key conflicts with another request.';
    end if;
    select * into v_existing from ticket_completion_authority.completion_evidence
    where request_id = v_request.request_id;
    if not found then
      raise exception 'Financial completion request is incomplete and requires governed retry.';
    end if;
    select coalesce(max(attempt_number), 0) + 1 into v_attempt_number
    from ticket_completion_authority.completion_attempts where request_id = v_request.request_id;
    insert into ticket_completion_authority.completion_attempts(
      attempt_id, request_id, attempt_number, result, evidence_hash
    ) values (
      gen_random_uuid(), v_request.request_id, v_attempt_number, 'REUSED',
      ticket_completion_authority.hash_json(jsonb_build_object(
        'requestId', v_request.request_id, 'attemptNumber', v_attempt_number,
        'result', 'REUSED', 'completionHash', v_existing.canonical_completion_hash
      ))
    );
    return jsonb_build_object(
      'completed', true, 'duplicate', true, 'completionId', v_existing.completion_id,
      'ticketId', p_ticket_id, 'lifecycleState', v_ticket.lifecycle_state,
      'completionHash', v_existing.canonical_completion_hash
    );
  end if;

  if exists (
    select 1 from ticket_completion_authority.completion_evidence where ticket_id = p_ticket_id
  ) then
    raise exception 'Ticket already has authoritative completion evidence with a different request.';
  end if;
  select count(*)::integer into v_item_count
  from ticket_authority.ticket_items where ticket_id = p_ticket_id;
  if v_item_count = 0 or v_source_count <> v_item_count then
    raise exception 'Financial completion requires exactly one source set for every ticket item.';
  end if;
  if (
    select count(distinct value->>'ticketItemId') from jsonb_array_elements(v_sources)
  ) <> v_source_count then
    raise exception 'Financial completion contains duplicate ticket item sources.';
  end if;

  insert into ticket_completion_authority.completion_requests(
    request_id, ticket_id, idempotency_key, canonical_request_hash, source_count,
    actor_reference, correlation_id, causation_id
  ) values (
    v_request_id, p_ticket_id, btrim(p_idempotency_key), v_request_hash, v_source_count,
    btrim(p_actor_reference), btrim(p_correlation_id), p_causation_id
  );

  for v_source in select value from jsonb_array_elements(v_sources)
  loop
    begin
      v_ticket_item_id := (v_source->>'ticketItemId')::uuid;
      v_settlement_id := (v_source->>'settlementId')::uuid;
      v_ledger_attempt_id := (v_source->>'ledgerExecutionAttemptId')::uuid;
      v_wallet_attempt_id := (v_source->>'walletExecutionAttemptId')::uuid;
      v_ledger_request_id := nullif(v_source->>'ledgerPostingRequestId', '')::uuid;
      v_wallet_operation_id := nullif(v_source->>'walletOperationId', '')::uuid;
    exception when others then
      raise exception 'Financial completion source identifiers are invalid.';
    end;
    select * into v_ticket_item from ticket_authority.ticket_items
    where ticket_item_id = v_ticket_item_id and ticket_id = p_ticket_id;
    if not found then
      raise exception 'Financial completion source does not belong to the ticket.';
    end if;

    select * into v_settlement
    from settlement_service.authoritative_settlement_records
    where settlement_id = v_settlement_id;
    if not found or v_settlement.ticket_id <> p_ticket_id::text
       or v_settlement.ticket_line_id <> v_ticket_item_id::text
       or v_settlement.stake_amount_minor <> v_ticket_item.stake_minor
       or v_settlement.currency <> v_ticket.currency then
      raise exception 'Authoritative Settlement completion does not match the ticket item.';
    end if;

    select * into v_ledger_attempt
    from settlement_service.financial_instruction_execution_attempts
    where attempt_id = v_ledger_attempt_id;
    select * into v_ledger_instruction from settlement_service.financial_instructions
    where instruction_id = v_ledger_attempt.instruction_id;
    if v_ledger_attempt.attempt_id is null
       or v_ledger_attempt.settlement_id <> v_settlement_id
       or v_ledger_attempt.target_service <> 'ledger-service'
       or v_ledger_attempt.status not in ('Posted', 'Skipped')
       or v_ledger_instruction.instruction_id is null
       or v_ledger_instruction.settlement_id <> v_settlement_id
       or v_ledger_instruction.target_service <> 'ledger-service' then
      raise exception 'Authoritative Ledger confirmation does not match Settlement.';
    end if;
    if v_ledger_attempt.status = 'Skipped' then
      if v_ledger_instruction.instruction_type <> 'LEDGER_NOOP'
         or v_ledger_request_id is not null then
        raise exception 'Only an explicit Ledger no-op may complete without a posting.';
      end if;
      v_ledger := null;
    else
      select * into v_ledger from ledger_service.ledger_posting_requests
      where id = v_ledger_request_id;
      if not found or v_ledger.request_kind <> 'POSTING'
         or v_ledger.request_status <> 'COMPLETED'
         or v_ledger.settlement_record_id is distinct from v_settlement_id
         or v_ledger.ledger_wallet_id <> v_ticket.wallet_id
         or v_ledger.ledger_account_id is distinct from v_ticket.player_account_id
         or v_ledger.ledger_entry_id is null or v_ledger.ledger_entry_hash is null
         or v_ledger_instruction.instruction_id::text <> v_ledger.instruction_id
         or v_ledger_instruction.canonical_payload_hash <> v_ledger.instruction_hash then
        raise exception 'Authoritative Ledger posting completion does not match Settlement.';
      end if;
    end if;

    select * into v_wallet_attempt
    from settlement_service.financial_instruction_execution_attempts
    where attempt_id = v_wallet_attempt_id;
    select * into v_wallet_instruction from settlement_service.financial_instructions
    where instruction_id = v_wallet_attempt.instruction_id;
    if v_wallet_attempt.attempt_id is null
       or v_wallet_attempt.settlement_id <> v_settlement_id
       or v_wallet_attempt.target_service <> 'credit-wallet-service'
       or v_wallet_attempt.status not in ('Posted', 'Skipped')
       or v_wallet_instruction.instruction_id is null
       or v_wallet_instruction.settlement_id <> v_settlement_id
       or v_wallet_instruction.target_service <> 'credit-wallet-service' then
      raise exception 'Authoritative Wallet confirmation does not match Settlement.';
    end if;
    if v_wallet_attempt.status = 'Skipped' then
      if v_wallet_instruction.instruction_type <> 'CREDIT_NOOP'
         or v_wallet_operation_id is not null then
        raise exception 'Only an explicit Wallet no-op may complete without an application.';
      end if;
      v_wallet := null;
      v_wallet_result := null;
    else
      select * into v_wallet from credit_wallet_service.wallet_operation_requests
      where operation_id = v_wallet_operation_id;
      select * into v_wallet_result
      from credit_wallet_service.wallet_operation_terminal_results
      where operation_id = v_wallet_operation_id and terminal_status = 'COMMITTED';
      if v_wallet.operation_id is null or v_wallet_result.operation_id is null
         or v_wallet.operation_type <> 'SETTLE'
         or v_wallet.authority <> 'settlement-service'
         or v_wallet.source_service <> 'settlement-service'
         or v_wallet.ticket_id is distinct from p_ticket_id
         or v_wallet.settlement_id is distinct from v_settlement_id
         or v_wallet.wallet_id <> v_ticket.wallet_id
         or v_wallet.player_id <> v_ticket.player_account_id
         or v_wallet.tenant_id <> v_ticket.tenant_id
         or v_wallet.brand_id <> v_ticket.brand_id
         or v_wallet.currency <> v_ticket.currency
         or v_wallet.amount_minor <> v_settlement.stake_amount_minor
         or v_wallet.reservation_id <> v_ticket.reservation_id
         or v_wallet.settlement_hash <> v_settlement.canonical_settlement_hash
         or v_wallet.settlement_version <> v_settlement.policy_version
         or (v_ledger.instruction_id is not null
             and v_wallet.ledger_instruction_id::text <> v_ledger.instruction_id)
         or v_wallet_instruction.instruction_id <> v_wallet.settlement_instruction_id
         or v_wallet_instruction.canonical_payload_hash <> v_wallet.settlement_instruction_hash then
        raise exception 'Authoritative Wallet completion does not match Ledger, Settlement, and ticket funding.';
      end if;
    end if;
    if v_ledger_attempt.created_at > v_wallet_attempt.created_at
       or (v_ledger.completed_at is not null and v_wallet_result.completed_at is not null
           and v_ledger.completed_at > v_wallet_result.completed_at) then
      raise exception 'Wallet completion cannot precede authoritative Ledger completion.';
    end if;

    insert into ticket_completion_authority.completion_sources(
      source_id, request_id, ticket_item_id, settlement_id, settlement_hash,
      ledger_execution_attempt_id,
      ledger_posting_request_id, ledger_entry_id, ledger_entry_hash,
      wallet_execution_attempt_id,
      wallet_operation_id, wallet_result_hash, canonical_source_hash
    ) values (
      gen_random_uuid(), v_request_id, v_ticket_item_id, v_settlement_id,
      v_settlement.canonical_settlement_hash, v_ledger_attempt_id,
      v_ledger.id, v_ledger.ledger_entry_id, v_ledger.ledger_entry_hash,
      v_wallet_attempt_id, v_wallet.operation_id, v_wallet_result.result_hash,
      ticket_completion_authority.hash_json(jsonb_build_object(
        'ticketItemId', v_ticket_item_id, 'settlementId', v_settlement_id,
        'settlementHash', v_settlement.canonical_settlement_hash,
        'ledgerExecutionAttemptId', v_ledger_attempt_id,
        'ledgerPostingRequestId', v_ledger.id, 'ledgerEntryId', v_ledger.ledger_entry_id,
        'ledgerEntryHash', v_ledger.ledger_entry_hash,
        'walletExecutionAttemptId', v_wallet_attempt_id,
        'walletOperationId', v_wallet.operation_id, 'walletResultHash', v_wallet_result.result_hash
      ))
    );
  end loop;

  select jsonb_agg(canonical_source_hash order by ticket_item_id) into v_source_hashes
  from ticket_completion_authority.completion_sources where request_id = v_request_id;
  v_completion_hash := ticket_completion_authority.hash_json(jsonb_build_object(
    'ticketId', p_ticket_id, 'sourceHashes', v_source_hashes
  ));

  if v_ticket.lifecycle_state not in (
    'SETTLEMENT_REQUESTED', 'SETTLEMENT_EXECUTED', 'LEDGER_POSTED',
    'WALLET_APPLIED', 'TICKET_SETTLED', 'COMMISSION_ELIGIBLE', 'REBATE_ELIGIBLE'
  ) then
    raise exception 'Ticket lifecycle state % does not permit financial completion.', v_ticket.lifecycle_state;
  end if;
  if v_ticket.lifecycle_state = 'SETTLEMENT_REQUESTED' then
    v_result := ticket_authority.execute_typed_lifecycle_command(
      'ConfirmSettlement', p_ticket_id, array['SETTLEMENT_REQUESTED'],
      'SETTLEMENT_EXECUTED', 'SETTLEMENT_PENDING', 'SETTLEMENT_AUTHORITY',
      v_request_id::text, v_request_hash, btrim(p_idempotency_key) || ':settlement',
      'AUTHORITATIVE_SETTLEMENT_COMPLETED', p_actor_reference, p_correlation_id,
      p_causation_id, jsonb_build_object('sourceCount', v_source_count)
    );
    v_ticket.lifecycle_state := 'SETTLEMENT_EXECUTED';
  end if;
  if v_ticket.lifecycle_state = 'SETTLEMENT_EXECUTED' then
    v_result := ticket_authority.execute_typed_lifecycle_command(
      'PostLedger', p_ticket_id, array['SETTLEMENT_EXECUTED'],
      'LEDGER_POSTED', 'SETTLEMENT_PENDING', 'LEDGER_AUTHORITY',
      v_request_id::text, v_request_hash, btrim(p_idempotency_key) || ':ledger',
      'AUTHORITATIVE_LEDGER_POSTED', p_actor_reference, p_correlation_id,
      p_causation_id, jsonb_build_object('sourceCount', v_source_count)
    );
    v_ticket.lifecycle_state := 'LEDGER_POSTED';
  end if;
  if v_ticket.lifecycle_state = 'LEDGER_POSTED' then
    v_result := ticket_authority.execute_typed_lifecycle_command(
      'ApplyWallet', p_ticket_id, array['LEDGER_POSTED'],
      'WALLET_APPLIED', 'SETTLEMENT_PENDING', 'CREDIT_WALLET_AUTHORITY',
      v_request_id::text, v_request_hash, btrim(p_idempotency_key) || ':wallet',
      'AUTHORITATIVE_WALLET_APPLIED', p_actor_reference, p_correlation_id,
      p_causation_id, jsonb_build_object('sourceCount', v_source_count)
    );
    v_ticket.lifecycle_state := 'WALLET_APPLIED';
  end if;
  if v_ticket.lifecycle_state = 'WALLET_APPLIED' then
    v_result := ticket_authority.execute_typed_lifecycle_command(
      'MarkSettled', p_ticket_id, array['WALLET_APPLIED'],
      'TICKET_SETTLED', 'SETTLED', 'TICKET_COMPLETION_AUTHORITY',
      v_completion_id::text, v_completion_hash,
      btrim(p_idempotency_key) || ':ticket-settled', 'FINANCIAL_COMPLETION_CONFIRMED',
      p_actor_reference, p_correlation_id, p_causation_id,
      jsonb_build_object('completionRequestId', v_request_id)
    );
    v_terminal_event_id := (v_result->>'eventId')::uuid;
    v_ticket.lifecycle_state := 'TICKET_SETTLED';
  end if;
  if v_ticket.lifecycle_state = 'TICKET_SETTLED' then
    v_result := ticket_authority.execute_typed_lifecycle_command(
      'MarkCommissionEligible', p_ticket_id, array['TICKET_SETTLED'],
      'COMMISSION_ELIGIBLE', 'SETTLED', 'COMPENSATION_AUTHORITY',
      v_completion_id::text, v_completion_hash,
      btrim(p_idempotency_key) || ':commission', 'COMPLETED_TICKET_ELIGIBILITY',
      p_actor_reference, p_correlation_id, p_causation_id,
      jsonb_build_object('completionRequestId', v_request_id)
    );
    v_ticket.lifecycle_state := 'COMMISSION_ELIGIBLE';
  end if;
  if v_ticket.lifecycle_state = 'COMMISSION_ELIGIBLE' then
    v_result := ticket_authority.execute_typed_lifecycle_command(
      'MarkRebateEligible', p_ticket_id, array['COMMISSION_ELIGIBLE'],
      'REBATE_ELIGIBLE', 'SETTLED', 'COMPENSATION_AUTHORITY',
      v_completion_id::text, v_completion_hash,
      btrim(p_idempotency_key) || ':rebate', 'COMPLETED_TICKET_ELIGIBILITY',
      p_actor_reference, p_correlation_id, p_causation_id,
      jsonb_build_object('completionRequestId', v_request_id)
    );
    v_ticket.lifecycle_state := 'REBATE_ELIGIBLE';
  end if;

  if v_terminal_event_id is null then
    select event_id into v_terminal_event_id
    from ticket_authority.ticket_lifecycle_events
    where ticket_id = p_ticket_id and command_type = 'MarkSettled'
    order by ticket_version desc limit 1;
  end if;
  if v_terminal_event_id is null then raise exception 'Ticket settled lifecycle evidence is missing.'; end if;

  insert into ticket_completion_authority.completion_evidence(
    completion_id, request_id, ticket_id, source_count,
    lifecycle_terminal_event_id, canonical_completion_hash
  ) values (
    v_completion_id, v_request_id, p_ticket_id, v_source_count,
    v_terminal_event_id, v_completion_hash
  );
  insert into ticket_completion_authority.completion_attempts(
    attempt_id, request_id, attempt_number, result, evidence_hash
  ) values (
    gen_random_uuid(), v_request_id, 1, 'COMPLETED',
    ticket_completion_authority.hash_json(jsonb_build_object(
      'requestId', v_request_id, 'attemptNumber', 1,
      'result', 'COMPLETED', 'completionHash', v_completion_hash
    ))
  );
  return jsonb_build_object(
    'completed', true, 'duplicate', false, 'completionId', v_completion_id,
    'ticketId', p_ticket_id, 'lifecycleState', v_ticket.lifecycle_state,
    'completionHash', v_completion_hash
  );
end;
$$;

drop function if exists ticket_authority.confirm_settlement(uuid,text,text,text,text,text,text,text,jsonb);
drop function if exists ticket_authority.post_ledger(uuid,text,text,text,text,text,text,text,jsonb);
drop function if exists ticket_authority.apply_wallet(uuid,text,text,text,text,text,text,text,jsonb);
drop function if exists ticket_authority.mark_settled(uuid,text,text,text,text,text,text,text,jsonb);
drop function if exists ticket_authority.mark_commission_eligible(uuid,text,text,text,text,text,text,text,jsonb);
drop function if exists ticket_authority.mark_rebate_eligible(uuid,text,text,text,text,text,text,text,jsonb);

comment on schema ticket_completion_authority is
  'Single financial Completion Authority. Tickets complete only from matching immutable Settlement, Ledger, and Wallet evidence for every ticket item.';
comment on table ticket_completion_authority.completion_evidence is
  'Append-only aggregate evidence binding all ticket item financial effects to the Ticket settled lifecycle event.';
