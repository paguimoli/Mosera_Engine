create table settlement_service.settlement_requests (
  settlement_request_id uuid primary key,
  idempotency_key text not null unique,
  canonical_request_hash text not null,
  settlement_input_id uuid not null references game_engine.settlement_input_records(settlement_input_id),
  settlement_input_hash text not null,
  math_evaluation_certificate_id uuid not null,
  math_evaluation_certificate_hash text not null,
  outcome_certificate_id uuid not null,
  outcome_certificate_hash text not null,
  ticket_id text not null,
  ticket_line_id text not null,
  player_account_reference text not null,
  accepted_wager_financial_context_reference text not null,
  accepted_stake_amount_minor bigint not null,
  currency text not null,
  minor_unit_precision integer not null,
  rounding_policy_reference text not null,
  credit_reservation_reference text,
  settlement_policy_version text not null,
  accepted_at timestamptz not null,
  mode text not null,
  status text not null,
  request_provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (canonical_request_hash like 'sha256:%'),
  check (settlement_input_hash like 'sha256:%'),
  check (math_evaluation_certificate_hash like 'sha256:%'),
  check (outcome_certificate_hash like 'sha256:%'),
  check (ticket_id <> ''),
  check (ticket_line_id <> ''),
  check (player_account_reference <> ''),
  check (accepted_wager_financial_context_reference <> ''),
  check (accepted_stake_amount_minor >= 0),
  check (currency ~ '^[A-Z]{3}$'),
  check (minor_unit_precision between 0 and 6),
  check (rounding_policy_reference <> ''),
  check (settlement_policy_version <> ''),
  check (mode in ('DryRun')),
  check (status in ('Accepted', 'Rejected'))
);

create table settlement_service.settlement_request_attempts (
  attempt_id uuid primary key,
  settlement_request_id uuid not null references settlement_service.settlement_requests(settlement_request_id),
  attempt_number integer not null,
  status text not null,
  evidence_hash text not null,
  validation_errors jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  check (attempt_number > 0),
  check (status in ('Accepted', 'Rejected', 'Conflict')),
  check (evidence_hash like 'sha256:%'),
  check (jsonb_typeof(validation_errors) = 'array'),
  unique (settlement_request_id, attempt_number)
);

create index idx_settlement_requests_input
  on settlement_service.settlement_requests(settlement_input_id, settlement_input_hash);

create index idx_settlement_requests_math_certificate
  on settlement_service.settlement_requests(math_evaluation_certificate_id, math_evaluation_certificate_hash);

create index idx_settlement_requests_ticket_line
  on settlement_service.settlement_requests(ticket_id, ticket_line_id);

create index idx_settlement_requests_context_reference
  on settlement_service.settlement_requests(accepted_wager_financial_context_reference);

create index idx_settlement_request_attempts_request
  on settlement_service.settlement_request_attempts(settlement_request_id, attempt_number);

create or replace function settlement_service.prevent_settlement_request_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'settlement_requests are append-only; create a new immutable request instead';
end;
$$;

create trigger trg_prevent_settlement_request_update
before update on settlement_service.settlement_requests
for each row execute function settlement_service.prevent_settlement_request_mutation();

create trigger trg_prevent_settlement_request_delete
before delete on settlement_service.settlement_requests
for each row execute function settlement_service.prevent_settlement_request_mutation();

create or replace function settlement_service.prevent_settlement_request_attempt_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'settlement_request_attempts are append-only; append a new attempt instead';
end;
$$;

create trigger trg_prevent_settlement_request_attempt_update
before update on settlement_service.settlement_request_attempts
for each row execute function settlement_service.prevent_settlement_request_attempt_mutation();

create trigger trg_prevent_settlement_request_attempt_delete
before delete on settlement_service.settlement_request_attempts
for each row execute function settlement_service.prevent_settlement_request_attempt_mutation();
