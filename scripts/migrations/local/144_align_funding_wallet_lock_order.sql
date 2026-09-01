begin;

do $$
declare
  v_identity regprocedure :=
    'funding_authority.resolve_funding_instrument(uuid,text,uuid,text,text,text,text)'::regprocedure;
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(v_identity) into v_definition;
  if position('canonical-wallet:' in v_definition) > 0 then
    return;
  end if;

  v_updated := replace(
    v_definition,
    E'  perform pg_advisory_xact_lock(hashtextextended(btrim(p_idempotency_key), 0));',
    E'  -- Match the Credit Wallet Authority lock order before any wallet FK evidence is inserted.\n' ||
    E'  perform pg_advisory_xact_lock(\n' ||
    E'    hashtextextended(''canonical-wallet:'' || v_wallet.id::text, 0));\n' ||
    E'  perform pg_advisory_xact_lock(hashtextextended(btrim(p_idempotency_key), 0));'
  );
  if v_updated = v_definition
     or position('canonical-wallet:' in v_updated) = 0
     or position('canonical-wallet:' in v_updated) > position('insert into funding_authority.resolution_events' in lower(v_updated)) then
    raise exception 'Canonical Funding Instrument wallet lock ordering could not be installed safely.';
  end if;
  execute v_updated;
end;
$$;

comment on function funding_authority.resolve_funding_instrument(
  uuid,text,uuid,text,text,text,text
) is
  'Resolves immutable ticket funding after acquiring the canonical per-wallet transaction lock, preventing wallet FK key-share/row-lock upgrade deadlocks with concurrent settlement.';

commit;
