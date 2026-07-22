create table credit_wallet_service.wallet_authority_evidence (
  evidence_id uuid primary key,
  evidence_type text not null check (evidence_type in (
    'PROMOTION_REHEARSAL',
    'ROLLBACK_REHEARSAL',
    'READINESS_VERIFICATION',
    'GUARDRAIL_EVALUATION',
    'BLOCKER_EVALUATION'
  )),
  authority_mode text not null check (authority_mode in (
    'MONOLITH', 'SERVICE_SHADOW', 'SERVICE_DRY_RUN', 'SERVICE'
  )),
  result text not null check (result in ('PASS', 'BLOCKED')),
  configuration_hash text not null check (configuration_hash ~ '^sha256:[0-9a-f]{64}$'),
  readiness_fingerprint text not null check (readiness_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  evidence_payload_hash text not null unique check (evidence_payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  evidence_payload jsonb not null check (jsonb_typeof(evidence_payload) = 'object'),
  operator_reference text not null check (operator_reference <> ''),
  created_at timestamptz not null default now()
);

create index idx_wallet_authority_evidence_type_result
  on credit_wallet_service.wallet_authority_evidence(evidence_type, result, created_at);
create index idx_wallet_authority_evidence_mode
  on credit_wallet_service.wallet_authority_evidence(authority_mode, created_at);
create index idx_wallet_authority_evidence_fingerprint
  on credit_wallet_service.wallet_authority_evidence(readiness_fingerprint);

create trigger wallet_authority_evidence_update_guard
before update on credit_wallet_service.wallet_authority_evidence
for each row execute function credit_wallet_service.prevent_evidence_mutation();

create trigger wallet_authority_evidence_delete_guard
before delete on credit_wallet_service.wallet_authority_evidence
for each row execute function credit_wallet_service.prevent_evidence_mutation();

comment on table credit_wallet_service.wallet_authority_evidence is
  'Append-only authority readiness, guardrail, blocker, promotion rehearsal, and rollback rehearsal evidence. It never switches CREDIT_AUTHORITY or mutates wallet state.';
