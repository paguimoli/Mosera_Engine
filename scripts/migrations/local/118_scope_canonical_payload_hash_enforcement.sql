create or replace function game_engine.bind_canonical_outcome_payload()
returns trigger
language plpgsql
as $$
declare
  canonical_payload_supplied boolean := new.canonical_payload is not null;
begin
  if not canonical_payload_supplied or btrim(new.canonical_payload) = '' then
    new.canonical_payload := new.outcome_payload::text;
  end if;

  if canonical_payload_supplied
     and 'sha256:' || encode(digest(new.canonical_payload, 'sha256'), 'hex')
       <> new.canonical_outcome_hash then
    raise exception 'Canonical outcome payload hash does not match the immutable outcome hash';
  end if;
  return new;
end;
$$;

create or replace function game_engine.bind_canonical_provider_result_payload()
returns trigger
language plpgsql
as $$
declare
  canonical_payload_supplied boolean := new.canonical_result_canonical_payload is not null;
begin
  if new.canonical_result_payload is null then
    if new.canonical_result_hash is not null
       or canonical_payload_supplied then
      raise exception 'Canonical provider result payload, canonical bytes, and hash must be supplied together';
    end if;
    return new;
  end if;

  if not canonical_payload_supplied
     or btrim(new.canonical_result_canonical_payload) = '' then
    new.canonical_result_canonical_payload := new.canonical_result_payload::text;
  end if;
  if canonical_payload_supplied
     and 'sha256:' || encode(digest(new.canonical_result_canonical_payload, 'sha256'), 'hex')
       <> new.canonical_result_hash then
    raise exception 'Canonical provider result payload hash does not match its immutable canonical bytes';
  end if;
  return new;
end;
$$;

comment on function game_engine.bind_canonical_outcome_payload() is
  'Validates exact canonical bytes when supplied by production adapters while preserving legacy dry-run JSONB fixtures.';
comment on function game_engine.bind_canonical_provider_result_payload() is
  'Validates exact canonical provider-result bytes when supplied by production adapters while preserving legacy fixtures.';
