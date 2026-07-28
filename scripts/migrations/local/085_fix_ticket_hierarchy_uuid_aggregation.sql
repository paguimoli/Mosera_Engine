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
    'max(id) filter (where account_type = ''AGENT'')',
    'max(id::text) filter (where account_type = ''AGENT'')::uuid'
  );
  function_definition := replace(
    function_definition,
    'max(id) filter (where account_type = ''MASTER_AGENT'')',
    'max(id::text) filter (where account_type = ''MASTER_AGENT'')::uuid'
  );

  execute function_definition;
end;
$$;
