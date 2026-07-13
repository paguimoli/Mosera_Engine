create table game_engine.math_evaluation_batches (
  batch_id uuid primary key,
  batch_idempotency_key text not null,
  canonical_batch_request_hash text not null,
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
  evaluator_type text not null,
  evaluator_version text not null,
  expected_item_count integer not null,
  completed_item_count integer not null default 0,
  failed_item_count integer not null default 0,
  status text not null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  failure_code text,
  failure_reason text,
  provenance_metadata jsonb not null default '{}'::jsonb,
  check (canonical_batch_request_hash like 'sha256:%'),
  check (outcome_certificate_hash like 'sha256:%'),
  check (game_manifest_hash like 'sha256:%'),
  check (math_model_hash like 'sha256:%'),
  check (paytable_hash like 'sha256:%'),
  check (expected_item_count > 0),
  check (completed_item_count >= 0),
  check (failed_item_count >= 0),
  check (status in ('Pending', 'Running', 'PartiallyCompleted', 'Completed', 'Failed', 'Cancelled')),
  check (jsonb_typeof(provenance_metadata) = 'object'),
  constraint ux_math_evaluation_batches_idempotency unique (batch_idempotency_key),
  constraint ux_math_evaluation_batches_scope unique (
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
    evaluator_version,
    batch_idempotency_key
  )
);

create table game_engine.math_evaluation_batch_items (
  batch_item_id uuid primary key,
  batch_id uuid not null references game_engine.math_evaluation_batches(batch_id),
  ticket_reference text not null,
  item_idempotency_key text not null,
  canonical_wager_payload_hash text not null,
  evaluation_request_id uuid references game_engine.math_evaluation_requests(evaluation_request_id),
  evaluation_status text not null,
  certificate_id uuid,
  certificate_hash text,
  attempt_count integer not null default 0,
  failure_code text,
  failure_reason text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (canonical_wager_payload_hash like 'sha256:%'),
  check (certificate_hash is null or certificate_hash like 'sha256:%'),
  check (attempt_count >= 0),
  check (evaluation_status in ('Pending', 'Running', 'Completed', 'Failed', 'Cancelled')),
  constraint ux_math_evaluation_batch_items_idempotency unique (item_idempotency_key),
  constraint ux_math_evaluation_batch_items_scope unique (
    batch_id,
    ticket_reference,
    canonical_wager_payload_hash
  ),
  constraint ux_math_evaluation_batch_items_certificate unique (certificate_id)
);

create table game_engine.math_evaluation_batch_attempts (
  batch_attempt_id uuid primary key,
  batch_id uuid not null references game_engine.math_evaluation_batches(batch_id),
  batch_item_id uuid references game_engine.math_evaluation_batch_items(batch_item_id),
  attempt_number integer not null,
  status text not null,
  failure_code text,
  failure_reason text,
  canonical_attempt_hash text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check (attempt_number > 0),
  check (canonical_attempt_hash like 'sha256:%'),
  check (status in ('Started', 'Completed', 'Failed', 'Recovered', 'Cancelled')),
  constraint ux_math_evaluation_batch_attempts_scope unique (batch_id, batch_item_id, attempt_number)
);

create index idx_math_evaluation_batches_status
  on game_engine.math_evaluation_batches(status);

create index idx_math_evaluation_batches_outcome_certificate
  on game_engine.math_evaluation_batches(outcome_certificate_id, outcome_certificate_hash);

create index idx_math_evaluation_batch_items_batch
  on game_engine.math_evaluation_batch_items(batch_id, evaluation_status);

create index idx_math_evaluation_batch_items_ticket
  on game_engine.math_evaluation_batch_items(ticket_reference);

create index idx_math_evaluation_batch_items_certificate_hash
  on game_engine.math_evaluation_batch_items(certificate_hash);

create index idx_math_evaluation_batch_attempts_batch
  on game_engine.math_evaluation_batch_attempts(batch_id, batch_item_id, attempt_number);

create or replace function game_engine.validate_math_evaluation_batch()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('Failed', 'Cancelled') and coalesce(new.failure_code, '') = '' then
    raise exception 'Failed or cancelled Math Evaluation batches require a failure code';
  end if;

  if new.status = 'Completed' and new.completed_item_count <> new.expected_item_count then
    raise exception 'Completed Math Evaluation batches require all items to be completed';
  end if;

  if new.status = 'Completed' and new.completed_at is null then
    raise exception 'Completed Math Evaluation batches require completed_at';
  end if;

  if new.provenance_metadata ? 'ledgerEntryId'
    or new.provenance_metadata ? 'walletTransactionId'
    or new.provenance_metadata ? 'cashMovement'
    or new.provenance_metadata ? 'rngReference'
    or new.provenance_metadata ? 'entropyReference' then
    raise exception 'Math Evaluation batches cannot contain financial or randomness references';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_math_evaluation_batch_item()
returns trigger
language plpgsql
as $$
begin
  if new.evaluation_status = 'Completed' then
    if new.evaluation_request_id is null or new.certificate_id is null or new.certificate_hash is null or new.completed_at is null then
      raise exception 'Completed Math Evaluation batch items require durable request and certificate evidence';
    end if;
  end if;

  if new.evaluation_status <> 'Completed' and (new.certificate_id is not null or new.certificate_hash is not null) then
    raise exception 'Incomplete Math Evaluation batch items cannot carry certificate evidence';
  end if;

  if new.evaluation_status in ('Failed', 'Cancelled') and coalesce(new.failure_code, '') = '' then
    raise exception 'Failed or cancelled Math Evaluation batch items require a failure code';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_math_evaluation_batch_attempt()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('Failed', 'Cancelled') and coalesce(new.failure_code, '') = '' then
    raise exception 'Failed or cancelled Math Evaluation batch attempts require a failure code';
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_math_evaluation_batch_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.math_evaluation_batches cannot be deleted; append cancellation evidence instead';
end;
$$;

create or replace function game_engine.prevent_math_evaluation_batch_item_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.math_evaluation_batch_items cannot be deleted; append cancellation evidence instead';
end;
$$;

create or replace function game_engine.prevent_math_evaluation_batch_attempt_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.math_evaluation_batch_attempts is append-only; create a new attempt instead';
end;
$$;

create trigger trg_validate_math_evaluation_batch
before insert or update on game_engine.math_evaluation_batches
for each row execute function game_engine.validate_math_evaluation_batch();

create trigger trg_prevent_math_evaluation_batch_delete
before delete on game_engine.math_evaluation_batches
for each row execute function game_engine.prevent_math_evaluation_batch_delete();

create trigger trg_validate_math_evaluation_batch_item
before insert or update on game_engine.math_evaluation_batch_items
for each row execute function game_engine.validate_math_evaluation_batch_item();

create trigger trg_prevent_math_evaluation_batch_item_delete
before delete on game_engine.math_evaluation_batch_items
for each row execute function game_engine.prevent_math_evaluation_batch_item_delete();

create trigger trg_validate_math_evaluation_batch_attempt
before insert on game_engine.math_evaluation_batch_attempts
for each row execute function game_engine.validate_math_evaluation_batch_attempt();

create trigger trg_prevent_math_evaluation_batch_attempt_update
before update on game_engine.math_evaluation_batch_attempts
for each row execute function game_engine.prevent_math_evaluation_batch_attempt_mutation();

create trigger trg_prevent_math_evaluation_batch_attempt_delete
before delete on game_engine.math_evaluation_batch_attempts
for each row execute function game_engine.prevent_math_evaluation_batch_attempt_mutation();

comment on table game_engine.math_evaluation_batches is
  'Durable Math Authority batch execution boundary for multiple wager evaluations against one verified Outcome Certificate. Production activation remains disabled.';

comment on table game_engine.math_evaluation_batch_items is
  'Durable Math Authority batch item state linking each wager to one durable Math Evaluation request and certificate evidence.';

comment on table game_engine.math_evaluation_batch_attempts is
  'Append-only Math Authority batch recovery, execution, and cancellation attempt evidence.';
