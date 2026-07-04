create table settlement_service.settlement_ledger_effects (
  id text primary key,
  settlement_run_id text not null references settlement_service.settlement_runs(id),
  settlement_record_id text not null,
  ticket_id text not null,
  ticket_line_id text not null,
  drawing_id text not null,
  account_id text not null,
  effect_type text not null,
  transaction_type text not null,
  direction text not null,
  amount numeric(18, 6) not null,
  idempotency_key text not null unique,
  posting_status text not null,
  reference_type text not null,
  reference_id text not null,
  reversal_of_ledger_effect_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (settlement_record_id <> ''),
  check (ticket_id <> ''),
  check (ticket_line_id <> ''),
  check (drawing_id <> ''),
  check (account_id <> ''),
  check (effect_type in ('WIN_PAYOUT', 'LOSS_RECOGNITION_NOOP', 'PUSH_REFUND', 'VOID_REFUND', 'SETTLEMENT_REVERSAL', 'SETTLEMENT_CORRECTION')),
  check (transaction_type in ('SETTLEMENT_CREDIT', 'SETTLEMENT_DEBIT', 'TICKET_REFUND', 'TICKET_VOID', 'REVERSAL')),
  check (direction in ('CREDIT', 'DEBIT', 'NOOP')),
  check (amount >= 0),
  check (posting_status in ('READY', 'NO_OP', 'POSTED', 'SKIPPED')),
  check (
    (posting_status = 'NO_OP' and direction = 'NOOP' and amount = 0)
    or (posting_status <> 'NO_OP' and direction in ('CREDIT', 'DEBIT') and amount > 0)
  )
);

create index idx_settlement_ledger_effects_run_id
  on settlement_service.settlement_ledger_effects (settlement_run_id);

create index idx_settlement_ledger_effects_record_id
  on settlement_service.settlement_ledger_effects (settlement_record_id);

create index idx_settlement_ledger_effects_ticket_draw
  on settlement_service.settlement_ledger_effects (ticket_id, drawing_id);

create index idx_settlement_ledger_effects_status
  on settlement_service.settlement_ledger_effects (posting_status);

create or replace function settlement_service.prevent_settlement_ledger_effect_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'settlement_ledger_effects are append-only; attempted update of %', old.id;
end;
$$;

create or replace function settlement_service.prevent_settlement_ledger_effect_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'settlement_ledger_effects are append-only; attempted delete of %', old.id;
end;
$$;

drop trigger if exists trg_prevent_settlement_ledger_effect_update
  on settlement_service.settlement_ledger_effects;
create trigger trg_prevent_settlement_ledger_effect_update
before update on settlement_service.settlement_ledger_effects
for each row execute function settlement_service.prevent_settlement_ledger_effect_update();

drop trigger if exists trg_prevent_settlement_ledger_effect_delete
  on settlement_service.settlement_ledger_effects;
create trigger trg_prevent_settlement_ledger_effect_delete
before delete on settlement_service.settlement_ledger_effects
for each row execute function settlement_service.prevent_settlement_ledger_effect_delete();
