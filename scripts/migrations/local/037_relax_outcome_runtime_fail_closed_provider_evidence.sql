create or replace function game_engine.validate_outcome_runtime_request()
returns trigger
language plpgsql
as $$
declare
  existing record;
  provider record;
begin
  if new.result_reference_placeholder is not null then
    raise exception 'Outcome runtime shell must not persist generated outcome references in this phase';
  end if;

  if new.evidence_reference_placeholder is not null and new.evidence_reference_placeholder !~ '^placeholder:' then
    raise exception 'Outcome runtime shell evidence reference must remain a placeholder in this phase';
  end if;

  if lower(new.idempotency_key) like '%rawseed%'
    or lower(new.idempotency_key) like '%serverseed%'
    or lower(new.failure_reason) like '%rawseed%'
    or lower(new.failure_reason) like '%serverseed%' then
    raise exception 'Outcome runtime persistence must not contain raw entropy, seed material, or DRBG state';
  end if;

  select *
    into provider
  from game_engine.outcome_provider_definitions
  where provider_id = new.provider_id
    and provider_version = new.provider_version;

  if not found then
    if new.status <> 'FailedClosed'
      or coalesce(new.failure_code, '') not in ('MissingProvider', 'RuntimeNotReady', 'TypeMismatch', 'VersionMismatch', 'CapabilityMismatch') then
      raise exception 'Outcome runtime request references an unknown Outcome Provider version';
    end if;
  elsif provider.provider_type <> new.provider_type then
    raise exception 'Outcome runtime request provider type does not match the provider definition';
  end if;

  if new.mode = 'Production' then
    raise exception 'Production Outcome Provider runtime generation is disabled';
  end if;

  select *
    into existing
  from game_engine.outcome_runtime_requests
  where idempotency_key = new.idempotency_key
    and draw_request_scope = new.draw_request_scope;

  if found and existing.canonical_request_hash <> new.canonical_request_hash then
    raise exception 'Conflicting payload for the same outcome runtime idempotency key';
  end if;

  return new;
end;
$$;
