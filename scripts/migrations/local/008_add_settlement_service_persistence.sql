create schema if not exists settlement_service;

create table settlement_service.settlement_runs (
  id text primary key,
  drawing_id text not null,
  game_id text not null,
  status text not null,
  expected_ticket_count integer not null default 0,
  expected_line_count integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  execution_id text,
  processed_ticket_count integer not null default 0,
  processed_line_count integer not null default 0,
  win_count integer not null default 0,
  loss_count integer not null default 0,
  push_count integer not null default 0,
  failed_count integer not null default 0,
  total_stake numeric(18, 6) not null default 0,
  total_payout numeric(18, 6) not null default 0,
  total_net numeric(18, 6) not null default 0,
  duration_ms integer not null default 0,
  tickets_per_second numeric(18, 6) not null default 0,
  lines_per_second numeric(18, 6) not null default 0,
  draw_to_settlement_ms integer,
  peak_concurrent_settlements integer not null default 0,
  notes text,
  record_hash text,
  previous_hash text,
  hash_version text,
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  check (drawing_id <> ''),
  check (game_id <> ''),
  check (status in (
    'pending',
    'running',
    'completed',
    'failed',
    'cancelled',
    'partially_completed',
    'recovering',
    'reversed'
  )),
  check (expected_ticket_count >= 0),
  check (expected_line_count >= 0),
  check (processed_ticket_count >= 0),
  check (processed_line_count >= 0),
  check (duration_ms >= 0),
  check (peak_concurrent_settlements >= 0)
);

create table settlement_service.settlement_records (
  id text primary key,
  settlement_run_id text not null references settlement_service.settlement_runs(id),
  ticket_id text not null,
  ticket_line_id text not null,
  account_id text not null,
  game_id text not null,
  drawing_id text not null,
  wager_type_id text not null,
  wager_option_id text,
  stake numeric(18, 6) not null default 0,
  payout numeric(18, 6) not null default 0,
  net_amount numeric(18, 6) not null default 0,
  outcome text not null,
  status text not null,
  version integer not null,
  previous_settlement_record_id text,
  reversal_of_settlement_record_id text,
  ledger_transaction_ids jsonb not null default '[]'::jsonb,
  record_hash text,
  previous_hash text,
  hash_version text,
  created_at timestamptz not null,
  persisted_at timestamptz not null default now(),
  check (ticket_id <> ''),
  check (ticket_line_id <> ''),
  check (account_id <> ''),
  check (game_id <> ''),
  check (drawing_id <> ''),
  check (wager_type_id <> ''),
  check (outcome in ('win', 'loss', 'push', 'void', 'failed')),
  check (status in ('pending', 'settled', 'reversed', 'failed', 'void')),
  check (version > 0),
  check (jsonb_typeof(ledger_transaction_ids) = 'array')
);

create unique index ux_settlement_runs_completed_drawing
  on settlement_service.settlement_runs (drawing_id)
  where status = 'completed';

create unique index ux_settlement_records_completed_ticket_line
  on settlement_service.settlement_records (drawing_id, ticket_id, ticket_line_id)
  where status = 'settled' and reversal_of_settlement_record_id is null;

create index idx_settlement_runs_drawing_id
  on settlement_service.settlement_runs (drawing_id);

create index idx_settlement_runs_status
  on settlement_service.settlement_runs (status);

create index idx_settlement_records_run_id
  on settlement_service.settlement_records (settlement_run_id);

create index idx_settlement_records_ticket_draw
  on settlement_service.settlement_records (ticket_id, drawing_id);

create index idx_settlement_records_ticket_line
  on settlement_service.settlement_records (ticket_line_id);

create or replace function settlement_service.prevent_settlement_record_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'settlement_records are append-only; attempted update of %', old.id;
end;
$$;

create or replace function settlement_service.prevent_settlement_record_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'settlement_records are append-only; attempted delete of %', old.id;
end;
$$;

drop trigger if exists trg_prevent_settlement_record_update
  on settlement_service.settlement_records;
create trigger trg_prevent_settlement_record_update
before update on settlement_service.settlement_records
for each row execute function settlement_service.prevent_settlement_record_update();

drop trigger if exists trg_prevent_settlement_record_delete
  on settlement_service.settlement_records;
create trigger trg_prevent_settlement_record_delete
before delete on settlement_service.settlement_records
for each row execute function settlement_service.prevent_settlement_record_delete();
