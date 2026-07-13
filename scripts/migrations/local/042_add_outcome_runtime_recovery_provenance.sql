create table game_engine.outcome_runtime_boot_identities (
  boot_id uuid primary key,
  runtime_instance_id text not null,
  process_id integer not null,
  container_id text,
  host_id text not null,
  hostname text not null,
  service_version text not null,
  semantic_version text not null,
  build_number text not null,
  git_commit_sha text not null,
  git_branch text,
  docker_image_digest text,
  build_timestamp timestamptz,
  boot_timestamp timestamptz not null,
  environment text not null,
  provider_configuration_version text not null,
  outcome_provider_id text,
  outcome_provider_version text,
  entropy_provider_id text,
  entropy_provider_version text,
  build_hash text not null,
  runtime_framework text not null,
  created_at timestamptz not null default now(),
  constraint ux_outcome_runtime_boot_identity unique (runtime_instance_id, boot_timestamp),
  constraint ux_outcome_runtime_boot_build_hash unique (boot_id, build_hash),
  constraint ck_outcome_runtime_boot_hash check (build_hash like 'sha256:%'),
  constraint ck_outcome_runtime_boot_git_commit check (length(git_commit_sha) > 0)
);

create table game_engine.outcome_runtime_request_provenance (
  provenance_id uuid primary key,
  runtime_request_id uuid not null references game_engine.outcome_runtime_requests(runtime_request_id),
  boot_id uuid not null references game_engine.outcome_runtime_boot_identities(boot_id),
  runtime_instance_id text not null,
  process_id integer not null,
  build_hash text not null,
  git_commit_sha text not null,
  docker_image_digest text,
  outcome_provider_id text,
  outcome_provider_version text,
  entropy_provider_id text,
  entropy_provider_version text,
  manifest_id text,
  manifest_version text,
  provider_configuration_version text not null,
  content_hash text not null unique,
  created_at timestamptz not null default now(),
  constraint ux_outcome_runtime_request_provenance unique (runtime_request_id, boot_id),
  constraint ck_outcome_runtime_request_provenance_hash check (content_hash like 'sha256:%' and build_hash like 'sha256:%')
);

create table game_engine.outcome_runtime_attempt_provenance (
  provenance_id uuid primary key,
  attempt_id uuid not null references game_engine.outcome_runtime_attempts(attempt_id),
  runtime_request_id uuid not null references game_engine.outcome_runtime_requests(runtime_request_id),
  boot_id uuid not null references game_engine.outcome_runtime_boot_identities(boot_id),
  runtime_instance_id text not null,
  process_id integer not null,
  build_hash text not null,
  git_commit_sha text not null,
  docker_image_digest text,
  outcome_provider_id text,
  outcome_provider_version text,
  entropy_provider_id text,
  entropy_provider_version text,
  manifest_id text,
  manifest_version text,
  provider_configuration_version text not null,
  content_hash text not null unique,
  created_at timestamptz not null default now(),
  constraint ux_outcome_runtime_attempt_provenance unique (attempt_id, boot_id),
  constraint ck_outcome_runtime_attempt_provenance_hash check (content_hash like 'sha256:%' and build_hash like 'sha256:%')
);

create table game_engine.outcome_runtime_recovery_evidence (
  evidence_id uuid primary key,
  event_type text not null,
  boot_id uuid not null references game_engine.outcome_runtime_boot_identities(boot_id),
  runtime_instance_id text not null,
  runtime_request_id uuid,
  attempt_id uuid,
  draw_request_scope text,
  provider_id text,
  provider_version text,
  provider_type text,
  reason_code text,
  details text,
  recovery_hash text not null,
  content_hash text not null unique,
  created_at timestamptz not null default now(),
  check (event_type in (
    'Boot',
    'Shutdown',
    'UnexpectedTermination',
    'Crash',
    'Restart',
    'StartupValidation',
    'RollbackDetection',
    'AbandonedRuntime',
    'RecoveredRuntime',
    'RecoveryAttempt',
    'LockRecovery',
    'ProviderRecovery'
  )),
  check (provider_type is null or provider_type in ('CERTIFIED_CSPRNG', 'PROVABLY_FAIR', 'EXTERNAL_OFFICIAL_RESULT', 'PHYSICAL_DRAW_RESULT', 'SIMULATION_TEST')),
  check (recovery_hash like 'sha256:%' and content_hash like 'sha256:%')
);

create index idx_outcome_runtime_boot_instance
  on game_engine.outcome_runtime_boot_identities(runtime_instance_id, boot_timestamp desc);

create index idx_outcome_runtime_request_provenance_request
  on game_engine.outcome_runtime_request_provenance(runtime_request_id, boot_id);

create index idx_outcome_runtime_attempt_provenance_attempt
  on game_engine.outcome_runtime_attempt_provenance(attempt_id, boot_id);

create index idx_outcome_runtime_recovery_evidence_boot
  on game_engine.outcome_runtime_recovery_evidence(boot_id, event_type, created_at desc);

create index idx_outcome_runtime_recovery_evidence_request
  on game_engine.outcome_runtime_recovery_evidence(runtime_request_id, event_type);

create index idx_outcome_runtime_recovery_evidence_provider
  on game_engine.outcome_runtime_recovery_evidence(provider_id, provider_version, provider_type);

create or replace function game_engine.prevent_outcome_runtime_recovery_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Outcome runtime recovery/provenance evidence is append-only';
end;
$$;

create or replace function game_engine.validate_outcome_runtime_recovery_text()
returns trigger
language plpgsql
as $$
declare
  combined text;
begin
  combined := lower(concat_ws('|',
    coalesce(new.runtime_instance_id, ''),
    coalesce(new.draw_request_scope, ''),
    coalesce(new.reason_code, ''),
    coalesce(new.details, ''),
    coalesce(new.provider_id, ''),
    coalesce(new.provider_version, '')
  ));

  if combined like '%rawseed%'
    or combined like '%raw seed%'
    or combined like '%serverseed%'
    or combined like '%server seed%'
    or combined like '%rawentropy%'
    or combined like '%raw entropy%'
    or combined like '%drbgstate%'
    or combined like '%drbg state%'
    or combined like '%secret%' then
    raise exception 'Outcome runtime recovery/provenance must not persist secrets, raw entropy, seed material, or DRBG state';
  end if;

  return new;
end;
$$;

create or replace function game_engine.detect_outcome_runtime_rollback()
returns boolean
language plpgsql
as $$
declare
  request_without_provenance integer;
  attempt_without_provenance integer;
  orphan_recovery integer;
begin
  select count(*)
    into request_without_provenance
  from game_engine.outcome_runtime_requests r
  where not exists (
    select 1
    from game_engine.outcome_runtime_request_provenance p
    where p.runtime_request_id = r.runtime_request_id
  );

  select count(*)
    into attempt_without_provenance
  from game_engine.outcome_runtime_attempts a
  where not exists (
    select 1
    from game_engine.outcome_runtime_attempt_provenance p
    where p.attempt_id = a.attempt_id
  );

  select count(*)
    into orphan_recovery
  from game_engine.outcome_runtime_recovery_evidence e
  where not exists (
    select 1
    from game_engine.outcome_runtime_boot_identities b
    where b.boot_id = e.boot_id
  );

  return request_without_provenance > 0
    or attempt_without_provenance > 0
    or orphan_recovery > 0;
end;
$$;

create trigger trg_prevent_outcome_runtime_boot_update
before update on game_engine.outcome_runtime_boot_identities
for each row execute function game_engine.prevent_outcome_runtime_recovery_mutation();

create trigger trg_prevent_outcome_runtime_boot_delete
before delete on game_engine.outcome_runtime_boot_identities
for each row execute function game_engine.prevent_outcome_runtime_recovery_mutation();

create trigger trg_prevent_outcome_runtime_request_provenance_update
before update on game_engine.outcome_runtime_request_provenance
for each row execute function game_engine.prevent_outcome_runtime_recovery_mutation();

create trigger trg_prevent_outcome_runtime_request_provenance_delete
before delete on game_engine.outcome_runtime_request_provenance
for each row execute function game_engine.prevent_outcome_runtime_recovery_mutation();

create trigger trg_prevent_outcome_runtime_attempt_provenance_update
before update on game_engine.outcome_runtime_attempt_provenance
for each row execute function game_engine.prevent_outcome_runtime_recovery_mutation();

create trigger trg_prevent_outcome_runtime_attempt_provenance_delete
before delete on game_engine.outcome_runtime_attempt_provenance
for each row execute function game_engine.prevent_outcome_runtime_recovery_mutation();

create trigger trg_validate_outcome_runtime_recovery_evidence
before insert on game_engine.outcome_runtime_recovery_evidence
for each row execute function game_engine.validate_outcome_runtime_recovery_text();

create trigger trg_prevent_outcome_runtime_recovery_update
before update on game_engine.outcome_runtime_recovery_evidence
for each row execute function game_engine.prevent_outcome_runtime_recovery_mutation();

create trigger trg_prevent_outcome_runtime_recovery_delete
before delete on game_engine.outcome_runtime_recovery_evidence
for each row execute function game_engine.prevent_outcome_runtime_recovery_mutation();

comment on table game_engine.outcome_runtime_boot_identities is
  'Append-only boot identities for Outcome Authority runtime provenance. Every process restart receives a new immutable boot id.';

comment on table game_engine.outcome_runtime_request_provenance is
  'Append-only provenance stamps for outcome runtime requests linking request state to boot, build, provider, entropy, manifest, and configuration versions.';

comment on table game_engine.outcome_runtime_attempt_provenance is
  'Append-only provenance stamps for outcome runtime attempts linking attempts to boot, build, provider, entropy, manifest, and configuration versions.';

comment on table game_engine.outcome_runtime_recovery_evidence is
  'Append-only recovery, restart, rollback detection, and crash-safety evidence. Secrets, raw entropy, seed material, and DRBG state are forbidden.';
