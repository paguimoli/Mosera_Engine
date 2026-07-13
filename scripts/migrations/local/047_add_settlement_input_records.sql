create table game_engine.settlement_input_records (
  settlement_input_id uuid primary key,
  math_evaluation_certificate_id uuid not null,
  math_evaluation_certificate_hash text not null,
  outcome_certificate_id uuid not null,
  outcome_certificate_hash text not null,
  ticket_reference text not null,
  game_manifest_id text not null,
  game_manifest_version text not null,
  game_manifest_hash text not null,
  math_model_id text not null,
  math_model_version text not null,
  math_model_hash text not null,
  paytable_id text not null,
  paytable_version text not null,
  paytable_hash text not null,
  evaluator_version text not null,
  evaluation_outcome text not null,
  prize_tier text not null,
  prize_facts jsonb not null,
  prize_facts_hash text not null,
  payout_units numeric(20, 6) not null,
  multiplier numeric(20, 6) not null,
  replay_hash text not null,
  idempotency_key text not null,
  issued_at timestamptz not null,
  provenance jsonb not null,
  canonical_payload jsonb not null,
  canonical_payload_hash text not null,
  created_at timestamptz not null default now(),
  check (math_evaluation_certificate_hash like 'sha256:%'),
  check (outcome_certificate_hash like 'sha256:%'),
  check (game_manifest_hash like 'sha256:%'),
  check (math_model_hash like 'sha256:%'),
  check (paytable_hash like 'sha256:%'),
  check (prize_facts_hash like 'sha256:%'),
  check (replay_hash like 'sha256:%'),
  check (canonical_payload_hash like 'sha256:%'),
  check (evaluation_outcome in ('Win', 'Loss', 'Push')),
  constraint ux_settlement_input_records_math_certificate unique (
    math_evaluation_certificate_id,
    math_evaluation_certificate_hash
  ),
  constraint ux_settlement_input_records_payload_hash unique (canonical_payload_hash),
  constraint ux_settlement_input_records_idempotency unique (idempotency_key)
);

create index idx_settlement_input_records_ticket
  on game_engine.settlement_input_records(ticket_reference);

create index idx_settlement_input_records_outcome_certificate
  on game_engine.settlement_input_records(outcome_certificate_id, outcome_certificate_hash);

create index idx_settlement_input_records_math_model
  on game_engine.settlement_input_records(math_model_id, math_model_version, math_model_hash);

create index idx_settlement_input_records_paytable
  on game_engine.settlement_input_records(paytable_id, paytable_version, paytable_hash);

create or replace function game_engine.validate_settlement_input_record()
returns trigger
language plpgsql
as $$
declare
  forbidden text[] := array[
    'balance',
    'wallet',
    'ledger',
    'commission',
    'tax',
    'cashier',
    'accountId',
    'walletId',
    'ledgerEntryId',
    'transactionId'
  ];
  value text;
  payload_text text;
begin
  if new.math_evaluation_certificate_hash <> new.prize_facts_hash then
    raise exception 'SettlementInput certificate hash must match PrizeFacts hash';
  end if;

  if new.canonical_payload->>'mathEvaluationCertificateHash' <> new.math_evaluation_certificate_hash then
    raise exception 'SettlementInput canonical payload certificate hash mismatch';
  end if;

  if new.canonical_payload->>'prizeFactsHash' <> new.prize_facts_hash then
    raise exception 'SettlementInput canonical payload PrizeFacts hash mismatch';
  end if;

  payload_text := lower(new.prize_facts::text || new.provenance::text || new.canonical_payload::text);
  foreach value in array forbidden loop
    if payload_text like '%' || lower(value) || '%' then
      raise exception 'SettlementInput cannot contain financial or settlement-side reference %', value;
    end if;
  end loop;

  return new;
end;
$$;

create or replace function game_engine.prevent_settlement_input_record_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.settlement_input_records is append-only; create a new immutable record instead';
end;
$$;

create trigger trg_validate_settlement_input_record
before insert on game_engine.settlement_input_records
for each row execute function game_engine.validate_settlement_input_record();

create trigger trg_prevent_settlement_input_record_update
before update on game_engine.settlement_input_records
for each row execute function game_engine.prevent_settlement_input_record_mutation();

create trigger trg_prevent_settlement_input_record_delete
before delete on game_engine.settlement_input_records
for each row execute function game_engine.prevent_settlement_input_record_mutation();

comment on table game_engine.settlement_input_records is
  'Append-only canonical SettlementInput handoff artifacts derived only from Math Evaluation Certificates. This table contains no balances, wallet references, ledger entries, commissions, taxes, cashier references, or settlement execution state.';
