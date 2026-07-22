create table ledger_service.ledger_promotion_rehearsals (
  promotion_rehearsal_id uuid primary key,
  authority_mode text not null,
  service_build_version text not null,
  configuration_hash text not null,
  readiness_report_hash text not null,
  test_request_set_hash text not null,
  result_summary text not null,
  comparison_summary jsonb not null,
  unresolved_blocker_count integer not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  operator_reference text not null,
  approval_metadata jsonb not null default '{}'::jsonb,
  canonical_evidence_hash text not null unique,
  created_at timestamptz not null default now(),
  check (authority_mode in ('SERVICE_SHADOW', 'SERVICE_DRY_RUN')),
  check (service_build_version <> ''),
  check (configuration_hash ~ '^sha256:[0-9a-f]{64}$'),
  check (readiness_report_hash ~ '^sha256:[0-9a-f]{64}$'),
  check (test_request_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  check (result_summary in ('PASS', 'BLOCKED')),
  check (jsonb_typeof(comparison_summary) = 'object'),
  check (unresolved_blocker_count >= 0),
  check (completed_at >= started_at),
  check (operator_reference <> ''),
  check (jsonb_typeof(approval_metadata) = 'object'),
  check (canonical_evidence_hash ~ '^sha256:[0-9a-f]{64}$')
);

create index idx_ledger_promotion_rehearsals_mode
  on ledger_service.ledger_promotion_rehearsals(authority_mode, completed_at);
create index idx_ledger_promotion_rehearsals_readiness
  on ledger_service.ledger_promotion_rehearsals(readiness_report_hash);
create index idx_ledger_promotion_rehearsals_result
  on ledger_service.ledger_promotion_rehearsals(result_summary, unresolved_blocker_count);

create or replace function ledger_service.prevent_ledger_promotion_rehearsal_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ledger_promotion_rehearsals are append-only; append new evidence instead';
end;
$$;

create trigger ledger_promotion_rehearsals_update_guard
before update on ledger_service.ledger_promotion_rehearsals
for each row execute function ledger_service.prevent_ledger_promotion_rehearsal_mutation();

create trigger ledger_promotion_rehearsals_delete_guard
before delete on ledger_service.ledger_promotion_rehearsals
for each row execute function ledger_service.prevent_ledger_promotion_rehearsal_mutation();

comment on table ledger_service.ledger_promotion_rehearsals is
  'Append-only Ledger Authority shadow and dry-run promotion evidence. Production SERVICE authority remains disabled.';
