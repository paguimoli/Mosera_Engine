do $$
declare
  function_definition text;
begin
  select pg_get_functiondef(
    'ticket_authority.cancel_ticket(uuid,text,text,text,text)'::regprocedure
  )
  into function_definition;

  if function_definition is null then
    raise exception 'canonical Ticket cancellation function is unavailable';
  end if;

  function_definition := replace(
    function_definition,
    $old$  v_request_hash text;
begin$old$,
    $new$  v_request_hash text;
  v_wallet_request_hash text;
  v_operation_id uuid := gen_random_uuid();
  v_release_id uuid;
  v_completed_at timestamptz;
begin$new$
  );

  function_definition := replace(
    function_definition,
    $old$  v_release := credit_wallet_service.cancel_wallet_reservation(
    gen_random_uuid(),$old$,
    $new$  v_wallet_request_hash := ticket_authority.hash_json(jsonb_build_object(
    'operation', 'CANCEL',
    'ticketId', v_ticket.ticket_id,
    'reservationId', v_reservation.id,
    'walletId', v_ticket.wallet_id,
    'tenantId', v_ticket.tenant_id,
    'brandId', v_ticket.brand_id,
    'playerId', v_ticket.player_account_id,
    'instrument', 'CREDIT',
    'currency', v_ticket.currency,
    'amountMinor', v_reservation.remaining_exposure,
    'reasonCode', p_reason_code
  ));

  insert into credit_wallet_service.wallet_operation_requests (
    operation_id,
    request_id,
    idempotency_key,
    canonical_request_hash,
    operation_type,
    authority,
    tenant_id,
    brand_id,
    player_id,
    wallet_id,
    instrument_code,
    currency,
    amount_minor,
    ticket_id,
    reservation_id,
    reason_code,
    source_service,
    effective_at,
    correlation_id,
    audit_metadata
  )
  values (
    v_operation_id,
    v_operation_id,
    'ticket-cancellation:' || btrim(p_idempotency_key),
    v_wallet_request_hash,
    'CANCEL',
    'ticket-authority',
    v_ticket.tenant_id,
    v_ticket.brand_id,
    v_ticket.player_account_id,
    v_ticket.wallet_id,
    'CREDIT',
    v_ticket.currency,
    v_reservation.remaining_exposure,
    v_ticket.ticket_id,
    v_reservation.id,
    p_reason_code,
    'ticket-authority',
    now(),
    coalesce(nullif(btrim(p_correlation_id), ''), v_operation_id::text),
    jsonb_build_object(
      'ticketAuthority', true,
      'requestedBy', p_requested_by
    )
  );

  v_release := credit_wallet_service.cancel_wallet_reservation(
    v_operation_id,$new$
  );

  function_definition := replace(
    function_definition,
    $old$  insert into ticket_authority.ticket_cancellation_requests ($old$,
    $new$  v_completed_at := clock_timestamp();
  select id into v_release_id
  from public.credit_reservation_releases
  where operation_id = v_operation_id;

  if v_release_id is null then
    raise exception 'Credit Wallet cancellation did not create release evidence';
  end if;

  insert into credit_wallet_service.wallet_operation_attempts (
    attempt_id,
    operation_id,
    attempt_number,
    result,
    started_at,
    completed_at,
    canonical_evidence_hash,
    audit_metadata
  )
  values (
    gen_random_uuid(),
    v_operation_id,
    1,
    'SUCCEEDED',
    v_completed_at,
    v_completed_at,
    ticket_authority.hash_json(jsonb_build_object(
      'operationId', v_operation_id,
      'result', 'SUCCEEDED',
      'releaseId', v_release_id,
      'release', v_release
    )),
    jsonb_build_object('ticketAuthority', true)
  );

  insert into credit_wallet_service.wallet_operation_terminal_results (
    terminal_result_id,
    operation_id,
    terminal_status,
    effect_reference_type,
    effect_reference_id,
    result_payload,
    result_hash,
    completed_at
  )
  values (
    gen_random_uuid(),
    v_operation_id,
    'COMMITTED',
    'credit_reservation_release',
    v_release_id::text,
    v_release,
    ticket_authority.hash_json(jsonb_build_object(
      'operationId', v_operation_id,
      'terminalStatus', 'COMMITTED',
      'releaseId', v_release_id,
      'release', v_release
    )),
    v_completed_at
  );

  insert into ticket_authority.ticket_cancellation_requests ($new$
  );

  function_definition := replace(
    function_definition,
    $old$    nullif(v_release->>'releaseId', '')::uuid,$old$,
    $new$    v_release_id,$new$
  );

  execute function_definition;
end;
$$;
