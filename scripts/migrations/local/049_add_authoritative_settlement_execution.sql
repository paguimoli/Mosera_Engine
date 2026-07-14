alter table game_engine.settlement_input_records
  drop constraint if exists settlement_input_records_evaluation_outcome_check;

alter table game_engine.settlement_input_records
  add constraint settlement_input_records_evaluation_outcome_check
  check (evaluation_outcome in ('Win', 'Loss', 'Push', 'Void', 'Rejected'));

create table settlement_service.authoritative_settlement_records (
  settlement_id uuid primary key,
  settlement_request_id uuid not null unique references settlement_service.settlement_requests(settlement_request_id),
  settlement_input_id uuid not null references game_engine.settlement_input_records(settlement_input_id),
  settlement_input_hash text not null,
  math_evaluation_certificate_id uuid not null,
  math_evaluation_certificate_hash text not null,
  outcome_certificate_id uuid not null,
  outcome_certificate_hash text not null,
  ticket_id text not null,
  ticket_line_id text not null,
  player_account_reference text not null,
  currency text not null,
  minor_unit_precision integer not null,
  stake_amount_minor bigint not null,
  gross_payout_amount_minor bigint not null,
  net_result_amount_minor bigint not null,
  settlement_outcome text not null,
  policy_version text not null,
  canonical_settlement_hash text not null unique,
  idempotency_key text not null unique,
  issued_at timestamptz not null,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (settlement_input_hash like 'sha256:%'),
  check (math_evaluation_certificate_hash like 'sha256:%'),
  check (outcome_certificate_hash like 'sha256:%'),
  check (canonical_settlement_hash like 'sha256:%'),
  check (ticket_id <> ''),
  check (ticket_line_id <> ''),
  check (player_account_reference <> ''),
  check (currency ~ '^[A-Z]{3}$'),
  check (minor_unit_precision between 0 and 6),
  check (stake_amount_minor >= 0),
  check (gross_payout_amount_minor >= 0),
  check (settlement_outcome in ('WIN', 'LOSS', 'PUSH', 'VOID', 'REJECTED')),
  check (policy_version <> ''),
  check (jsonb_typeof(provenance) = 'object')
);

create table settlement_service.settlement_execution_attempts (
  attempt_id uuid primary key,
  settlement_request_id uuid not null references settlement_service.settlement_requests(settlement_request_id),
  attempt_number integer not null,
  status text not null,
  canonical_settlement_hash text,
  evidence_hash text not null,
  errors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  check (attempt_number > 0),
  check (status in ('Completed', 'Failed', 'Conflict', 'ReplayVerified', 'ReplayMismatch')),
  check (canonical_settlement_hash is null or canonical_settlement_hash like 'sha256:%'),
  check (evidence_hash like 'sha256:%'),
  check (jsonb_typeof(errors) = 'array'),
  unique (settlement_request_id, attempt_number)
);

create index idx_authoritative_settlement_records_input
  on settlement_service.authoritative_settlement_records(settlement_input_id, settlement_input_hash);

create index idx_authoritative_settlement_records_math_certificate
  on settlement_service.authoritative_settlement_records(math_evaluation_certificate_id, math_evaluation_certificate_hash);

create index idx_authoritative_settlement_records_outcome_certificate
  on settlement_service.authoritative_settlement_records(outcome_certificate_id, outcome_certificate_hash);

create index idx_authoritative_settlement_records_ticket_line
  on settlement_service.authoritative_settlement_records(ticket_id, ticket_line_id);

create index idx_settlement_execution_attempts_request
  on settlement_service.settlement_execution_attempts(settlement_request_id, attempt_number);

create or replace function settlement_service.prevent_authoritative_settlement_record_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'authoritative_settlement_records are append-only; create a new governed correction instead';
end;
$$;

create trigger trg_prevent_authoritative_settlement_record_update
before update on settlement_service.authoritative_settlement_records
for each row execute function settlement_service.prevent_authoritative_settlement_record_mutation();

create trigger trg_prevent_authoritative_settlement_record_delete
before delete on settlement_service.authoritative_settlement_records
for each row execute function settlement_service.prevent_authoritative_settlement_record_mutation();

create or replace function settlement_service.prevent_settlement_execution_attempt_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'settlement_execution_attempts are append-only; append a new attempt instead';
end;
$$;

create trigger trg_prevent_settlement_execution_attempt_update
before update on settlement_service.settlement_execution_attempts
for each row execute function settlement_service.prevent_settlement_execution_attempt_mutation();

create trigger trg_prevent_settlement_execution_attempt_delete
before delete on settlement_service.settlement_execution_attempts
for each row execute function settlement_service.prevent_settlement_execution_attempt_mutation();

comment on table settlement_service.authoritative_settlement_records is
  'Append-only authoritative SettlementRecords derived only from canonical SettlementInput ingestion requests. Contains no ledger ids, wallet ids, commissions, taxes, cashier effects, or financial posting state.';
