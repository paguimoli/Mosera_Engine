do $$
declare
  function_definition text;
begin
  select pg_get_functiondef(
    'ticket_authority.accept_ticket(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,jsonb,text,text,text,text,text)'::regprocedure
  )
  into function_definition;

  if function_definition is null then
    raise exception 'canonical Ticket acceptance function is unavailable';
  end if;

  function_definition := replace(
    function_definition,
    'lifecycle_state = ''Active''',
    'lifecycle_state = ''ProductionActive'''
  );

  execute function_definition;
end;
$$;
