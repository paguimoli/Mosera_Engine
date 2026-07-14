create table settlement_service.settlement_promotion_rehearsals (
  promotion_rehearsal_id uuid primary key,
  authority_mode text not null,
  service_build_version text not null,
  configuration_hash text not null,
  readiness_report_hash text not null,
  test_request_set_hash text not null,
  result_summary text not null,
  comparison_summary text not null,
  unresolved_blocker_count integer not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  operator_reference text not null,
  approval_metadata jsonb not null default '{}'::jsonb,
  canonical_evidence_hash text not null unique,
  created_at timestamptz not null default now(),
  check (authority_mode in ('SERVICE_SHADOW', 'SERVICE_DRY_RUN')),
  check (service_build_version <> ''),
  check (configuration_hash like 'sha256:%'),
  check (readiness_report_hash like 'sha256:%'),
  check (test_request_set_hash like 'sha256:%'),
  check (result_summary in ('PASS', 'BLOCKED')),
  check (comparison_summary <> ''),
  check (unresolved_blocker_count >= 0),
  check (completed_at >= started_at),
  check (operator_reference <> ''),
  check (jsonb_typeof(approval_metadata) = 'object'),
  check (canonical_evidence_hash like 'sha256:%')
);

create index idx_settlement_promotion_rehearsals_mode
  on settlement_service.settlement_promotion_rehearsals(authority_mode, completed_at);

create index idx_settlement_promotion_rehearsals_readiness
  on settlement_service.settlement_promotion_rehearsals(readiness_report_hash);

create index idx_settlement_promotion_rehearsals_result
  on settlement_service.settlement_promotion_rehearsals(result_summary, unresolved_blocker_count);

create or replace function settlement_service.prevent_settlement_promotion_rehearsal_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'settlement_promotion_rehearsals are append-only; append a new rehearsal evidence row instead';
end;
$$;

create trigger trg_prevent_settlement_promotion_rehearsal_update
before update on settlement_service.settlement_promotion_rehearsals
for each row execute function settlement_service.prevent_settlement_promotion_rehearsal_mutation();

create trigger trg_prevent_settlement_promotion_rehearsal_delete
before delete on settlement_service.settlement_promotion_rehearsals
for each row execute function settlement_service.prevent_settlement_promotion_rehearsal_mutation();

comment on table settlement_service.settlement_promotion_rehearsals is
  'Append-only Settlement Authority promotion dry-run evidence. SERVICE production authority remains disabled; only SERVICE_SHADOW and SERVICE_DRY_RUN rehearsals are permitted.';
