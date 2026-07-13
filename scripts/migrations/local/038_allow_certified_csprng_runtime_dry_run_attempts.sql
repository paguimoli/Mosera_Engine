create or replace function game_engine.validate_outcome_runtime_attempt()
returns trigger
language plpgsql
as $$
begin
  if lower(new.failure_reason) like '%rawseed%'
    or lower(new.failure_reason) like '%serverseed%'
    or lower(new.lock_scope) like '%rawseed%'
    or lower(new.lock_scope) like '%serverseed%' then
    raise exception 'Outcome runtime attempt evidence must not contain raw entropy, seed material, or DRBG state';
  end if;

  if new.status = 'Accepted'
    and not (
      new.provider_type = 'CERTIFIED_CSPRNG'
      and new.mode in ('DryRun', 'Simulation')
      and new.failure_code = 'None'
    ) then
    raise exception 'Only Certified CSPRNG dry-run/simulation attempts can be accepted while production authority remains disabled';
  end if;

  if new.mode = 'Production' then
    raise exception 'Production Outcome Provider runtime generation is disabled';
  end if;

  return new;
end;
$$;

comment on function game_engine.validate_outcome_runtime_attempt() is
  'Rejects raw secret material and production attempts; permits accepted Certified CSPRNG dry-run/simulation attempts with no financial or authority side effects.';
