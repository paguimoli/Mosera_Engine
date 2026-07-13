create table game_engine.math_evaluation_requests (
  evaluation_request_id uuid primary key,
  idempotency_key text not null,
  canonical_request_hash text not null,
  outcome_certificate_id uuid not null,
  outcome_certificate_hash text not null,
  game_manifest_id text not null,
  game_manifest_version text not null,
  game_manifest_hash text not null,
  math_model_id text not null,
  math_model_version text not null,
  math_model_hash text not null,
  paytable_id text not null,
  paytable_version text not null,
  paytable_hash text not null,
  ticket_reference text not null,
  wager_schema text not null,
  evaluator_type text not null,
  evaluator_version text not null,
  evaluation_mode text not null,
  status text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  failure_code text,
  failure_reason text,
  math_evaluation_id uuid,
  certificate_id uuid,
  certificate_hash text,
  check (canonical_request_hash like 'sha256:%'),
  check (outcome_certificate_hash like 'sha256:%'),
  check (game_manifest_hash like 'sha256:%'),
  check (math_model_hash like 'sha256:%'),
  check (paytable_hash like 'sha256:%'),
  check (certificate_hash is null or certificate_hash like 'sha256:%'),
  check (evaluation_mode in ('DryRun', 'Simulation', 'ProductionDisabled')),
  check (status in ('Claimed', 'Completed', 'Failed')),
  constraint ux_math_evaluation_requests_idempotency unique (idempotency_key),
  constraint ux_math_evaluation_requests_scope unique (
    ticket_reference,
    outcome_certificate_id,
    outcome_certificate_hash,
    game_manifest_id,
    game_manifest_version,
    game_manifest_hash,
    math_model_id,
    math_model_version,
    math_model_hash,
    paytable_id,
    paytable_version,
    paytable_hash,
    evaluator_type,
    evaluator_version
  ),
  constraint ux_math_evaluation_requests_certificate unique (certificate_id)
);

create table game_engine.math_evaluation_attempts (
  attempt_id uuid primary key,
  evaluation_request_id uuid not null references game_engine.math_evaluation_requests(evaluation_request_id),
  attempt_number integer not null,
  status text not null,
  failure_code text,
  failure_reason text,
  canonical_attempt_hash text not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check (attempt_number > 0),
  check (canonical_attempt_hash like 'sha256:%'),
  check (status in ('Started', 'Completed', 'Failed', 'ReplayVerified', 'ReplayMismatch')),
  constraint ux_math_evaluation_attempts_request_number unique (evaluation_request_id, attempt_number)
);

create index idx_math_evaluation_requests_outcome_certificate
  on game_engine.math_evaluation_requests(outcome_certificate_id, outcome_certificate_hash);

create index idx_math_evaluation_requests_ticket
  on game_engine.math_evaluation_requests(ticket_reference);

create index idx_math_evaluation_requests_certificate_hash
  on game_engine.math_evaluation_requests(certificate_hash);

create index idx_math_evaluation_requests_status
  on game_engine.math_evaluation_requests(status);

create index idx_math_evaluation_attempts_request
  on game_engine.math_evaluation_attempts(evaluation_request_id, attempt_number);

create or replace function game_engine.validate_math_evaluation_request()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'Completed' then
    if new.completed_at is null
      or new.math_evaluation_id is null
      or new.certificate_id is null
      or new.certificate_hash is null then
      raise exception 'Completed Math Evaluation requests require completion evidence';
    end if;
  end if;

  if new.status <> 'Completed' and (
    new.math_evaluation_id is not null
    or new.certificate_id is not null
    or new.certificate_hash is not null) then
    raise exception 'Incomplete Math Evaluation requests cannot carry certificate evidence';
  end if;

  if new.status = 'Failed' and coalesce(new.failure_code, '') = '' then
    raise exception 'Failed Math Evaluation requests require a failure code';
  end if;

  if new.evaluation_mode = 'ProductionDisabled' then
    raise exception 'Production Math Authority evaluation is disabled';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_math_evaluation_attempt()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('Failed', 'ReplayMismatch') and coalesce(new.failure_code, '') = '' then
    raise exception 'Failed Math Evaluation attempts require a failure code';
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_math_evaluation_attempt_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.math_evaluation_attempts is append-only; create a new attempt instead';
end;
$$;

create trigger trg_validate_math_evaluation_request
before insert or update on game_engine.math_evaluation_requests
for each row execute function game_engine.validate_math_evaluation_request();

create trigger trg_validate_math_evaluation_attempt
before insert on game_engine.math_evaluation_attempts
for each row execute function game_engine.validate_math_evaluation_attempt();

create trigger trg_prevent_math_evaluation_attempt_update
before update on game_engine.math_evaluation_attempts
for each row execute function game_engine.prevent_math_evaluation_attempt_mutation();

create trigger trg_prevent_math_evaluation_attempt_delete
before delete on game_engine.math_evaluation_attempts
for each row execute function game_engine.prevent_math_evaluation_attempt_mutation();

comment on table game_engine.math_evaluation_requests is
  'Durable Math Authority request boundary for certificate-based evaluation idempotency, replay, and completion evidence. Production Math Authority remains disabled.';

comment on table game_engine.math_evaluation_attempts is
  'Append-only Math Authority evaluation attempt evidence. Attempts record retries and replay verification without mutating original evaluation evidence.';
