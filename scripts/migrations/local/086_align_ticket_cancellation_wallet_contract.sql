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
    $old$    'CREDIT',
    v_ticket.ticket_id,
    v_reservation.remaining_exposure,
    'ticket-cancellation:' || btrim(p_idempotency_key),
    p_correlation_id,
    p_reason_code
  )$old$,
    $new$    'CREDIT',
    v_ticket.ticket_id::text,
    v_reservation.remaining_exposure,
    v_ticket.currency,
    'ticket-cancellation:' || btrim(p_idempotency_key),
    p_correlation_id,
    p_reason_code,
    jsonb_build_object('ticketAuthority', true)
  )$new$
  );

  execute function_definition;
end;
$$;
