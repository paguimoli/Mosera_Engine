create table game_engine.outcome_runtime_requests (
  runtime_request_id uuid primary key,
  idempotency_key text not null,
  draw_request_scope text not null,
  game_manifest_id text not null,
  game_manifest_version text not null,
  provider_id text not null,
  provider_version text not null,
  provider_type text not null,
  mode text not null,
  status text not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  failure_code text,
  failure_reason text,
  canonical_request_hash text not null,
  result_reference_placeholder text,
  evidence_reference_placeholder text,
  lock_scope text not null,
  lock_acquired boolean not null default false,
  created_at timestamptz not null default now(),
  constraint ux_outcome_runtime_requests_idempotency_scope unique (idempotency_key, draw_request_scope),
  check (provider_type in ('CERTIFIED_CSPRNG', 'PROVABLY_FAIR', 'EXTERNAL_OFFICIAL_RESULT', 'PHYSICAL_DRAW_RESULT', 'SIMULATION_TEST')),
  check (mode in ('DryRun', 'Simulation', 'Production')),
  check (status in ('Accepted', 'DuplicateReturned', 'FailedClosed', 'ProductionDisabled', 'GenerationNotImplemented')),
  check (canonical_request_hash like 'sha256:%' or canonical_request_hash like 'sha384:%' or canonical_request_hash like 'sha512:%'),
  check (completed_at is null or completed_at >= started_at)
);

create table game_engine.outcome_runtime_attempts (
  attempt_id uuid primary key,
  runtime_request_id uuid not null,
  idempotency_key text not null,
  draw_request_scope text not null,
  provider_id text not null,
  provider_version text not null,
  provider_type text not null,
  mode text not null,
  status text not null,
  failure_code text,
  failure_reason text,
  lock_scope text not null,
  lock_acquired boolean not null default false,
  canonical_attempt_hash text not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint ux_outcome_runtime_attempts_hash unique (canonical_attempt_hash),
  check (provider_type in ('CERTIFIED_CSPRNG', 'PROVABLY_FAIR', 'EXTERNAL_OFFICIAL_RESULT', 'PHYSICAL_DRAW_RESULT', 'SIMULATION_TEST')),
  check (mode in ('DryRun', 'Simulation', 'Production')),
  check (status in ('Accepted', 'DuplicateReturned', 'FailedClosed', 'ProductionDisabled', 'GenerationNotImplemented')),
  check (canonical_attempt_hash like 'sha256:%' or canonical_attempt_hash like 'sha384:%' or canonical_attempt_hash like 'sha512:%'),
  check (completed_at is null or completed_at >= started_at)
);

create index idx_outcome_runtime_requests_idempotency_scope
  on game_engine.outcome_runtime_requests(idempotency_key, draw_request_scope);

create index idx_outcome_runtime_requests_manifest
  on game_engine.outcome_runtime_requests(game_manifest_id, game_manifest_version);

create index idx_outcome_runtime_requests_provider
  on game_engine.outcome_runtime_requests(provider_id, provider_version, provider_type);

create index idx_outcome_runtime_requests_status
  on game_engine.outcome_runtime_requests(status);

create index idx_outcome_runtime_requests_lock_scope
  on game_engine.outcome_runtime_requests(lock_scope);

create index idx_outcome_runtime_attempts_request
  on game_engine.outcome_runtime_attempts(runtime_request_id);

create index idx_outcome_runtime_attempts_provider
  on game_engine.outcome_runtime_attempts(provider_id, provider_version, provider_type);

create index idx_outcome_runtime_attempts_scope
  on game_engine.outcome_runtime_attempts(draw_request_scope, lock_scope);

create index idx_outcome_runtime_attempts_status
  on game_engine.outcome_runtime_attempts(status);

create or replace function game_engine.prevent_outcome_runtime_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Outcome runtime persistence is append-only; create a new request or attempt row instead';
end;
$$;

create or replace function game_engine.jsonb_runtime_has_forbidden_secret_material(payload jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  item record;
begin
  if payload is null then
    return false;
  end if;

  if jsonb_typeof(payload) = 'object' then
    for item in select key, value from jsonb_each(payload)
    loop
      if lower(item.key) like '%rawentropy%'
        or lower(item.key) like '%entropybytes%'
        or lower(item.key) like '%rawseed%'
        or lower(item.key) like '%serverseed%'
        or lower(item.key) like '%plaintextseed%'
        or lower(item.key) like '%drbgstate%'
        or lower(item.key) like '%internalstate%'
        or lower(item.key) like '%secretstate%' then
        return true;
      end if;

      if game_engine.jsonb_runtime_has_forbidden_secret_material(item.value) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(payload) = 'array' then
    for item in select value from jsonb_array_elements(payload)
    loop
      if game_engine.jsonb_runtime_has_forbidden_secret_material(item.value) then
        return true;
      end if;
    end loop;
  end if;

  return false;
end;
$$;

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
    raise exception 'Outcome runtime request references an unknown Outcome Provider version';
  end if;

  if provider.provider_type <> new.provider_type then
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

  if new.status = 'Accepted' then
    raise exception 'Outcome runtime attempts cannot mark generation accepted in this phase';
  end if;

  return new;
end;
$$;

create or replace function game_engine.try_outcome_runtime_advisory_lock(lock_scope text)
returns boolean
language sql
as $$
  select pg_try_advisory_xact_lock(hashtextextended(lock_scope, 0));
$$;

create trigger trg_validate_outcome_runtime_request
before insert on game_engine.outcome_runtime_requests
for each row execute function game_engine.validate_outcome_runtime_request();

create trigger trg_prevent_outcome_runtime_request_update
before update on game_engine.outcome_runtime_requests
for each row execute function game_engine.prevent_outcome_runtime_mutation();

create trigger trg_prevent_outcome_runtime_request_delete
before delete on game_engine.outcome_runtime_requests
for each row execute function game_engine.prevent_outcome_runtime_mutation();

create trigger trg_validate_outcome_runtime_attempt
before insert on game_engine.outcome_runtime_attempts
for each row execute function game_engine.validate_outcome_runtime_attempt();

create trigger trg_prevent_outcome_runtime_attempt_update
before update on game_engine.outcome_runtime_attempts
for each row execute function game_engine.prevent_outcome_runtime_mutation();

create trigger trg_prevent_outcome_runtime_attempt_delete
before delete on game_engine.outcome_runtime_attempts
for each row execute function game_engine.prevent_outcome_runtime_mutation();

comment on table game_engine.outcome_runtime_requests is
  'Append-only Outcome Provider runtime idempotency boundary. Stores request state only; no outcome generation, raw entropy, seed, or DRBG state.';

comment on table game_engine.outcome_runtime_attempts is
  'Append-only Outcome Provider runtime attempt evidence. Records fail-closed orchestration shell attempts and lock evidence.';
