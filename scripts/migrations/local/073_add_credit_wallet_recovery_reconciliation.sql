create table credit_wallet_service.wallet_recovery_runs (
  recovery_run_id uuid primary key default gen_random_uuid(),
  trigger_type text not null check (trigger_type in ('STARTUP', 'MANUAL', 'RETRY')),
  run_status text not null check (run_status in ('COMPLETED', 'COMPLETED_WITH_BLOCKED', 'FAILED')),
  scanned_count integer not null check (scanned_count >= 0),
  recovered_count integer not null check (recovered_count >= 0),
  blocked_count integer not null check (blocked_count >= 0),
  conflict_count integer not null check (conflict_count >= 0),
  canonical_evidence_hash text not null unique check (canonical_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  started_at timestamptz not null,
  completed_at timestamptz not null check (completed_at >= started_at),
  created_at timestamptz not null default now()
);

create table credit_wallet_service.wallet_recovery_evidence (
  recovery_evidence_id uuid primary key default gen_random_uuid(),
  recovery_run_id uuid references credit_wallet_service.wallet_recovery_runs(recovery_run_id),
  operation_id uuid not null references credit_wallet_service.wallet_operation_requests(operation_id),
  classification text not null check (classification in ('COMMITTED', 'FAILED', 'INCOMPLETE', 'UNKNOWN', 'CONFLICT', 'BLOCKED')),
  action text not null check (action in ('CLASSIFIED', 'REUSED', 'RECOVERED', 'RETRIED', 'BLOCKED', 'CONFLICT')),
  before_state jsonb not null,
  after_state jsonb not null,
  reason_code text not null,
  canonical_request_hash text not null check (canonical_request_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_evidence_hash text not null unique check (canonical_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  correlation_id text not null,
  created_at timestamptz not null default now()
);
create index idx_wallet_recovery_evidence_operation
  on credit_wallet_service.wallet_recovery_evidence(operation_id, created_at);
create index idx_wallet_recovery_evidence_classification
  on credit_wallet_service.wallet_recovery_evidence(classification, created_at);

create table credit_wallet_service.wallet_replay_evidence (
  replay_evidence_id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references credit_wallet_service.wallet_operation_requests(operation_id),
  replay_result text not null check (replay_result in ('MATCH', 'MISMATCH', 'INCONCLUSIVE', 'BLOCKED')),
  original_request_hash text not null check (original_request_hash ~ '^sha256:[0-9a-f]{64}$'),
  replay_request_hash text check (replay_request_hash is null or replay_request_hash ~ '^sha256:[0-9a-f]{64}$'),
  original_result_hash text,
  replay_result_hash text,
  mismatches jsonb not null default '[]'::jsonb,
  canonical_evidence_hash text not null unique check (canonical_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  correlation_id text not null,
  verified_at timestamptz not null default now()
);
create index idx_wallet_replay_evidence_operation
  on credit_wallet_service.wallet_replay_evidence(operation_id, verified_at);

create table credit_wallet_service.wallet_projection_baselines (
  baseline_id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null unique references public.financial_wallets(id),
  baseline_balance bigint not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  instrument_code text not null references credit_wallet_service.wallet_instrument_definitions(instrument_code),
  source_snapshot_hash text not null check (source_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_evidence_hash text not null unique check (canonical_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create table credit_wallet_service.wallet_projection_verifications (
  verification_id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.financial_wallets(id),
  verification_result text not null check (verification_result in ('MATCH', 'DRIFT', 'INCONCLUSIVE')),
  expected_balance bigint not null,
  observed_balance bigint not null,
  expected_exposure bigint not null,
  observed_exposure bigint not null,
  findings jsonb not null default '[]'::jsonb,
  canonical_evidence_hash text not null unique check (canonical_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  correlation_id text not null,
  verified_at timestamptz not null default now()
);
create index idx_wallet_projection_verifications_wallet
  on credit_wallet_service.wallet_projection_verifications(wallet_id, verified_at);
create index idx_wallet_projection_verifications_result
  on credit_wallet_service.wallet_projection_verifications(verification_result, verified_at);

create table credit_wallet_service.wallet_reconciliation_evidence (
  reconciliation_id uuid primary key default gen_random_uuid(),
  reconciliation_type text not null check (reconciliation_type in ('LEDGER', 'SETTLEMENT')),
  reconciliation_result text not null check (reconciliation_result in ('MATCH', 'MISMATCH', 'INCONCLUSIVE')),
  checked_count integer not null check (checked_count >= 0),
  mismatch_count integer not null check (mismatch_count >= 0),
  findings jsonb not null default '[]'::jsonb,
  canonical_evidence_hash text not null unique check (canonical_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  correlation_id text not null,
  verified_at timestamptz not null default now()
);
create index idx_wallet_reconciliation_evidence_type
  on credit_wallet_service.wallet_reconciliation_evidence(reconciliation_type, verified_at);
create index idx_wallet_reconciliation_evidence_result
  on credit_wallet_service.wallet_reconciliation_evidence(reconciliation_result, verified_at);

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'wallet_recovery_runs', 'wallet_recovery_evidence', 'wallet_replay_evidence',
    'wallet_projection_baselines', 'wallet_projection_verifications',
    'wallet_reconciliation_evidence'
  ] loop
    execute format('create trigger %I before update on credit_wallet_service.%I for each row execute function credit_wallet_service.prevent_evidence_mutation()', v_table || '_update_guard', v_table);
    execute format('create trigger %I before delete on credit_wallet_service.%I for each row execute function credit_wallet_service.prevent_evidence_mutation()', v_table || '_delete_guard', v_table);
  end loop;
end;
$$;

comment on table credit_wallet_service.wallet_recovery_evidence is
  'Append-only classification and governed recovery evidence. Recovery reuses canonical operation identity and never defines a second financial mutation path.';
comment on table credit_wallet_service.wallet_projection_verifications is
  'Append-only drift detection evidence. Verification never repairs wallet or reservation projections.';
