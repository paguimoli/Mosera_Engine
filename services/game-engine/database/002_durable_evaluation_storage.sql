-- Phase 22.6L durable evaluation storage draft. Do not apply automatically.
-- Game Engine owns evaluation records. Settlement consumes by governed contract only.
-- No financial posting, ledger posting, credit mutation, or settlement mutation is performed here.

create schema if not exists game_engine;

create table if not exists game_engine.evaluation_runs (
  id uuid primary key,
  draw_id uuid not null,
  game_binding_id uuid not null,
  official_certified_draw_result_id uuid not null,
  game_module_id text not null,
  game_module_version text not null,
  evaluation_version text not null,
  status text not null,
  batch_size integer not null,
  eligible_ticket_count integer not null default 0,
  planned_batch_count integer not null default 0,
  preconditions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  check (batch_size > 0),
  check (eligible_ticket_count >= 0),
  check (planned_batch_count >= 0)
);

create table if not exists game_engine.evaluation_batches (
  id uuid primary key,
  evaluation_run_id uuid not null references game_engine.evaluation_runs(id),
  sequence integer not null,
  start_inclusive integer not null,
  end_exclusive integer not null,
  status text not null,
  checkpoint_cursor text not null default '',
  retry_count integer not null default 0,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  unique (evaluation_run_id, sequence),
  check (sequence >= 0),
  check (start_inclusive >= 0),
  check (end_exclusive >= start_inclusive),
  check (retry_count >= 0)
);

create table if not exists game_engine.evaluation_records (
  id uuid primary key,
  idempotency_key text not null unique,
  evaluation_run_id uuid not null references game_engine.evaluation_runs(id),
  evaluation_batch_id uuid not null references game_engine.evaluation_batches(id),
  ticket_id uuid not null,
  draw_id uuid not null,
  game_id uuid not null,
  game_module_id text not null,
  game_module_version text not null,
  evaluator_version text not null,
  paytable_version text not null,
  outcome text not null,
  reason_code text not null,
  currency text not null,
  stake_amount numeric(20, 6) not null,
  payout_amount numeric(20, 6) not null,
  net_amount numeric(20, 6) not null,
  evaluation_metadata jsonb not null default '{}'::jsonb,
  evaluated_at timestamptz not null default now(),
  settlement_consumed_at timestamptz,
  settlement_consumed_by text,
  settlement_consumer_status text not null default 'NOT_CONSUMED',
  settlement_consumer_correlation_id uuid,
  check (settlement_consumer_status in ('NOT_CONSUMED', 'READY', 'CONSUMED', 'SKIPPED', 'BLOCKED', 'FAILED'))
);

comment on table game_engine.evaluation_records is
  'Immutable Game Engine output. Settlement may consume these records by governed contract in a future phase; this table does not post financial effects.';
comment on column game_engine.evaluation_records.idempotency_key is
  'Unique replay-safety key. Duplicate evaluation attempts must return the existing record.';
comment on column game_engine.evaluation_records.settlement_consumer_status is
  'Future governed Settlement consumer status. Consumption is not active in Phase 22.6L.';
comment on column game_engine.evaluation_records.settlement_consumed_at is
  'Nullable future Settlement consumer marker. Game Engine owns evaluation records; Settlement consumption is by contract only.';

create table if not exists game_engine.evaluation_checkpoints (
  evaluation_run_id uuid not null references game_engine.evaluation_runs(id),
  evaluation_batch_id uuid primary key references game_engine.evaluation_batches(id),
  cursor text not null,
  processed_count integer not null default 0,
  failed_count integer not null default 0,
  retry_count integer not null default 0,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (processed_count >= 0),
  check (failed_count >= 0),
  check (retry_count >= 0)
);

create index if not exists idx_evaluation_records_draw_id on game_engine.evaluation_records(draw_id);
create index if not exists idx_evaluation_records_ticket_id on game_engine.evaluation_records(ticket_id);
create index if not exists idx_evaluation_records_run_id on game_engine.evaluation_records(evaluation_run_id);
create index if not exists idx_evaluation_records_batch_id on game_engine.evaluation_records(evaluation_batch_id);
create index if not exists idx_evaluation_records_game_id on game_engine.evaluation_records(game_id);
create index if not exists idx_evaluation_records_settlement_status on game_engine.evaluation_records(settlement_consumer_status);

create or replace function game_engine.prevent_evaluation_record_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.evaluation_records is append-only; use governed supersession/remediation workflows';
end;
$$;

drop trigger if exists trg_prevent_evaluation_record_update on game_engine.evaluation_records;
create trigger trg_prevent_evaluation_record_update
before update on game_engine.evaluation_records
for each row execute function game_engine.prevent_evaluation_record_mutation();

drop trigger if exists trg_prevent_evaluation_record_delete on game_engine.evaluation_records;
create trigger trg_prevent_evaluation_record_delete
before delete on game_engine.evaluation_records
for each row execute function game_engine.prevent_evaluation_record_mutation();

comment on trigger trg_prevent_evaluation_record_update on game_engine.evaluation_records is
  'Append-only guard: evaluation records cannot be updated after insert.';
comment on trigger trg_prevent_evaluation_record_delete on game_engine.evaluation_records is
  'Append-only guard: evaluation records cannot be deleted after insert.';
