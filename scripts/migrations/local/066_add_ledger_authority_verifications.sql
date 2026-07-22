create table ledger_service.ledger_authority_verifications (
  verification_id uuid primary key,
  build_version text not null,
  configuration_hash text not null,
  migration_version text not null,
  readiness_fingerprint text not null unique,
  verification_timestamp timestamptz not null,
  authority_mode text not null,
  verification_result text not null,
  verified_capabilities jsonb not null,
  blocking_findings jsonb not null,
  warning_findings jsonb not null,
  known_limitations jsonb not null,
  canonical_verification_hash text not null unique,
  created_at timestamptz not null default now(),
  check (build_version <> ''),
  check (configuration_hash ~ '^sha256:[0-9a-f]{64}$'),
  check (migration_version <> ''),
  check (readiness_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  check (authority_mode in ('MONOLITH', 'SERVICE_SHADOW', 'SERVICE_DRY_RUN')),
  check (verification_result in ('IMPLEMENTATION_COMPLETE', 'IMPLEMENTATION_INCOMPLETE')),
  check (jsonb_typeof(verified_capabilities) = 'array'),
  check (jsonb_typeof(blocking_findings) = 'array'),
  check (jsonb_typeof(warning_findings) = 'array'),
  check (jsonb_typeof(known_limitations) = 'array'),
  check (canonical_verification_hash ~ '^sha256:[0-9a-f]{64}$')
);

create index idx_ledger_authority_verifications_result
  on ledger_service.ledger_authority_verifications(verification_result, verification_timestamp);
create index idx_ledger_authority_verifications_migration
  on ledger_service.ledger_authority_verifications(migration_version);
create index idx_ledger_authority_verifications_authority
  on ledger_service.ledger_authority_verifications(authority_mode, verification_timestamp);

create or replace function ledger_service.prevent_ledger_authority_verification_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ledger_authority_verifications are append-only; append new verification evidence instead';
end;
$$;

create trigger ledger_authority_verifications_update_guard
before update on ledger_service.ledger_authority_verifications
for each row execute function ledger_service.prevent_ledger_authority_verification_mutation();

create trigger ledger_authority_verifications_delete_guard
before delete on ledger_service.ledger_authority_verifications
for each row execute function ledger_service.prevent_ledger_authority_verification_mutation();

comment on table ledger_service.ledger_authority_verifications is
  'Append-only final Ledger Authority implementation verification evidence. It does not activate production authority.';
