create table operational_governance.change_policy_versions (
  change_policy_id uuid primary key,
  change_type text not null check (change_type in (
    'CONFIGURATION_PUBLICATION', 'PRODUCT_PUBLICATION',
    'PROVIDER_ACTIVATION', 'PROVIDER_DEACTIVATION',
    'DRAW_SCHEDULE_PUBLICATION', 'PLATFORM_MAINTENANCE',
    'RECOVERY_EXECUTION', 'PRODUCTION_RELEASE'
  )),
  version integer not null check (version > 0),
  operational_command_types text[] not null check (cardinality(operational_command_types) > 0),
  verification_required boolean not null default true,
  authority_acceptance_required boolean not null default true,
  readiness_required boolean not null default true,
  audit_required boolean not null default true,
  retry_allowed boolean not null default true,
  maximum_attempts integer not null check (maximum_attempts between 1 and 10),
  effective_from timestamptz not null,
  effective_to timestamptz,
  content_hash text not null unique check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (change_type, version),
  check (effective_to is null or effective_to > effective_from)
);

create unique index ux_operational_change_active_policy
  on operational_governance.change_policy_versions(change_type)
  where effective_to is null;

create table operational_governance.change_requests (
  change_id uuid primary key,
  command_id uuid not null unique references operational_governance.commands(command_id),
  change_type text not null,
  idempotency_key text not null unique,
  canonical_change_hash text not null check (canonical_change_hash ~ '^sha256:[0-9a-f]{64}$'),
  actor_identity_id text not null,
  reason text not null check (btrim(reason) <> ''),
  affected_authority text not null,
  target_type text not null,
  target_id text not null,
  expected_state jsonb not null,
  correlation_id text not null,
  causation_id text,
  change_policy_id uuid not null references operational_governance.change_policy_versions(change_policy_id),
  change_policy_version integer not null,
  requested_at timestamptz not null default now()
);

create index idx_operational_changes_target
  on operational_governance.change_requests(affected_authority, target_type, target_id, requested_at desc);
create index idx_operational_changes_correlation
  on operational_governance.change_requests(correlation_id, requested_at desc);

create table operational_governance.change_attempts (
  attempt_id uuid primary key,
  change_id uuid not null references operational_governance.change_requests(change_id),
  attempt integer not null check (attempt > 0),
  executor_identity_id text not null,
  status text not null check (status in (
    'STARTED', 'SUCCEEDED', 'RECOVERABLE_FAILURE', 'TERMINAL_FAILURE'
  )),
  result_payload jsonb not null default '{}'::jsonb,
  result_hash text not null check (result_hash ~ '^sha256:[0-9a-f]{64}$'),
  failure_code text,
  failure_reason text,
  correlation_id text not null,
  causation_id text,
  recorded_at timestamptz not null default now(),
  unique (change_id, attempt, status),
  unique (change_id, attempt, result_hash)
);

create table operational_governance.change_verification_evidence (
  verification_id uuid primary key,
  change_id uuid not null references operational_governance.change_requests(change_id),
  attempt integer not null check (attempt > 0),
  decision text not null check (decision in ('VERIFIED', 'FAILED')),
  expected_state_hash text not null check (expected_state_hash ~ '^sha256:[0-9a-f]{64}$'),
  observed_state jsonb not null,
  observed_state_hash text not null check (observed_state_hash ~ '^sha256:[0-9a-f]{64}$'),
  expected_state_reached boolean not null,
  authority_accepted boolean not null,
  readiness_maintained boolean not null,
  audit_recorded boolean not null,
  verifier_identity_id text not null,
  reason text not null,
  correlation_id text not null,
  causation_id text,
  evidence_hash text not null unique check (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  verified_at timestamptz not null default now(),
  unique (change_id, attempt)
);

create table operational_governance.maintenance_events (
  maintenance_event_id uuid primary key,
  change_id uuid not null unique references operational_governance.change_requests(change_id),
  website_id text not null,
  action text not null check (action in ('BEGIN', 'END')),
  actor_identity_id text not null,
  reason text not null,
  correlation_id text not null,
  evidence_hash text not null unique check (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamptz not null default now()
);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'change_policy_versions', 'change_requests', 'change_attempts',
    'change_verification_evidence', 'maintenance_events'
  ] loop
    execute format(
      'create trigger %I before update or delete on operational_governance.%I for each row execute function operational_governance.prevent_immutable_mutation()',
      'trg_' || table_name || '_immutable', table_name
    );
  end loop;
end;
$$;

create or replace function operational_governance.request_change(
  p_change_id uuid,
  p_command_id uuid,
  p_change_type text,
  p_idempotency_key text,
  p_canonical_change_hash text,
  p_expected_state jsonb
) returns operational_governance.change_requests
language plpgsql as $$
declare
  existing operational_governance.change_requests%rowtype;
  command_record operational_governance.commands%rowtype;
  policy operational_governance.change_policy_versions%rowtype;
  inserted operational_governance.change_requests%rowtype;
begin
  select * into existing from operational_governance.change_requests
   where idempotency_key = p_idempotency_key;
  if found then
    if existing.canonical_change_hash <> p_canonical_change_hash
       or existing.command_id <> p_command_id then
      raise exception 'Operational change idempotency conflict.' using errcode = '23505';
    end if;
    return existing;
  end if;

  select * into command_record from operational_governance.commands where command_id = p_command_id;
  if not found then raise exception 'Operational command not found.'; end if;
  select * into policy from operational_governance.change_policy_versions
   where change_type = p_change_type and effective_from <= now()
     and (effective_to is null or effective_to > now())
   order by version desc limit 1;
  if not found then raise exception 'No active operational change policy for %.', p_change_type; end if;
  if not (command_record.command_type = any(policy.operational_command_types)) then
    raise exception 'Operational command type is incompatible with the requested change type.';
  end if;

  insert into operational_governance.change_requests (
    change_id, command_id, change_type, idempotency_key, canonical_change_hash,
    actor_identity_id, reason, affected_authority, target_type, target_id,
    expected_state, correlation_id, causation_id, change_policy_id, change_policy_version
  ) values (
    p_change_id, p_command_id, p_change_type, p_idempotency_key, p_canonical_change_hash,
    command_record.actor_identity_id, command_record.reason, command_record.affected_authority,
    command_record.target_type, command_record.target_id, p_expected_state,
    command_record.correlation_id, command_record.causation_id,
    policy.change_policy_id, policy.version
  ) returning * into inserted;
  return inserted;
exception when unique_violation then
  select * into existing from operational_governance.change_requests
   where idempotency_key = p_idempotency_key;
  if found and existing.canonical_change_hash = p_canonical_change_hash
     and existing.command_id = p_command_id then return existing; end if;
  raise exception 'Operational change idempotency conflict.' using errcode = '23505';
end;
$$;

create or replace function operational_governance.begin_change_execution(
  p_change_id uuid,
  p_command_id uuid,
  p_executor_identity_id text,
  p_expected_change_type text
) returns integer language plpgsql as $$
declare change_record operational_governance.change_requests%rowtype;
declare policy operational_governance.change_policy_versions%rowtype;
declare next_attempt integer;
begin
  select * into change_record from operational_governance.change_requests
   where change_id = p_change_id and command_id = p_command_id for share;
  if not found then raise exception 'Operational change request was not found for command.'; end if;
  if change_record.change_type <> p_expected_change_type then
    raise exception 'Operational change type mismatch.';
  end if;
  if not exists (
    select 1 from operational_governance.security_validation_evidence evidence
     where evidence.command_id = p_command_id
       and evidence.executor_identity_id = p_executor_identity_id
       and evidence.decision in ('AUTHORIZED', 'NOT_REQUIRED_NON_PRODUCTION')
  ) then raise exception 'Operational security authorization evidence is required.'; end if;
  if exists (
    select 1 from operational_governance.change_verification_evidence verification
     where verification.change_id = p_change_id and verification.decision = 'VERIFIED'
  ) then return 0; end if;
  select * into policy from operational_governance.change_policy_versions
   where change_policy_id = change_record.change_policy_id;
  select coalesce(max(attempt), 0) + 1 into next_attempt
    from operational_governance.change_attempts where change_id = p_change_id;
  if next_attempt > policy.maximum_attempts then raise exception 'Operational change retry limit exceeded.'; end if;
  if next_attempt > 1 and not policy.retry_allowed then raise exception 'Operational change retry is not permitted.'; end if;
  insert into operational_governance.change_attempts (
    attempt_id, change_id, attempt, executor_identity_id, status, result_payload,
    result_hash, correlation_id, causation_id
  ) values (
    gen_random_uuid(), p_change_id, next_attempt, p_executor_identity_id, 'STARTED', '{}'::jsonb,
    'sha256:' || encode(digest(p_change_id::text || ':' || next_attempt::text || ':STARTED', 'sha256'), 'hex'),
    change_record.correlation_id, change_record.causation_id
  );
  return next_attempt;
end;
$$;

create or replace function operational_governance.complete_change_execution(
  p_change_id uuid,
  p_attempt integer,
  p_executor_identity_id text,
  p_result_payload jsonb,
  p_observed_state jsonb,
  p_expected_state_reached boolean,
  p_authority_accepted boolean,
  p_readiness_maintained boolean,
  p_audit_recorded boolean,
  p_failure_code text default null,
  p_failure_reason text default null
) returns operational_governance.change_verification_evidence
language plpgsql as $$
declare change_record operational_governance.change_requests%rowtype;
declare policy operational_governance.change_policy_versions%rowtype;
declare verification_decision text;
declare attempt_status text;
declare inserted operational_governance.change_verification_evidence%rowtype;
begin
  select * into change_record from operational_governance.change_requests where change_id = p_change_id;
  if not found then raise exception 'Operational change request was not found.'; end if;
  select * into policy from operational_governance.change_policy_versions
   where change_policy_id = change_record.change_policy_id;
  if p_attempt <= 0 then
    select * into inserted from operational_governance.change_verification_evidence
     where change_id = p_change_id and decision = 'VERIFIED' order by attempt desc limit 1;
    if not found then raise exception 'Completed operational change evidence is unavailable.'; end if;
    return inserted;
  end if;
  if not exists (
    select 1 from operational_governance.change_attempts
     where change_id = p_change_id and attempt = p_attempt and status = 'STARTED'
       and executor_identity_id = p_executor_identity_id
  ) then raise exception 'Operational change execution attempt is unavailable.'; end if;

  verification_decision := case when
    (not policy.verification_required or p_expected_state_reached)
    and (not policy.authority_acceptance_required or p_authority_accepted)
    and (not policy.readiness_required or p_readiness_maintained)
    and (not policy.audit_required or p_audit_recorded)
    and p_failure_code is null then 'VERIFIED' else 'FAILED' end;
  attempt_status := case when verification_decision = 'VERIFIED' then 'SUCCEEDED'
    when policy.retry_allowed then 'RECOVERABLE_FAILURE' else 'TERMINAL_FAILURE' end;

  insert into operational_governance.change_attempts (
    attempt_id, change_id, attempt, executor_identity_id, status, result_payload,
    result_hash, failure_code, failure_reason, correlation_id, causation_id
  ) values (
    gen_random_uuid(), p_change_id, p_attempt, p_executor_identity_id, attempt_status,
    coalesce(p_result_payload, '{}'::jsonb),
    'sha256:' || encode(digest(p_change_id::text || ':' || p_attempt::text || ':' || attempt_status || ':' || coalesce(p_result_payload, '{}'::jsonb)::text, 'sha256'), 'hex'),
    p_failure_code, p_failure_reason, change_record.correlation_id, change_record.causation_id
  );

  insert into operational_governance.change_verification_evidence (
    verification_id, change_id, attempt, decision, expected_state_hash,
    observed_state, observed_state_hash, expected_state_reached, authority_accepted,
    readiness_maintained, audit_recorded, verifier_identity_id, reason,
    correlation_id, causation_id, evidence_hash
  ) values (
    gen_random_uuid(), p_change_id, p_attempt, verification_decision,
    'sha256:' || encode(digest(change_record.expected_state::text, 'sha256'), 'hex'),
    coalesce(p_observed_state, '{}'::jsonb),
    'sha256:' || encode(digest(coalesce(p_observed_state, '{}'::jsonb)::text, 'sha256'), 'hex'),
    p_expected_state_reached, p_authority_accepted, p_readiness_maintained,
    p_audit_recorded, p_executor_identity_id,
    coalesce(p_failure_reason, case when verification_decision = 'VERIFIED'
      then 'Canonical change verification passed.' else 'Canonical change verification failed.' end),
    change_record.correlation_id, change_record.causation_id,
    'sha256:' || encode(digest(p_change_id::text || ':' || p_attempt::text || ':' || verification_decision, 'sha256'), 'hex')
  ) returning * into inserted;
  return inserted;
end;
$$;

create or replace function operational_governance.operational_change_readiness()
returns table(check_name text, ready boolean, issue_count integer)
language sql stable as $$
  select * from (values
    ('operational_change:policy_catalog', exists(select 1 from operational_governance.change_policy_versions where effective_to is null), 0),
    ('operational_change:immutable_requests', exists(select 1 from pg_trigger where tgname = 'trg_change_requests_immutable'), 0),
    ('operational_change:immutable_attempts', exists(select 1 from pg_trigger where tgname = 'trg_change_attempts_immutable'), 0),
    ('operational_change:mandatory_verification', exists(select 1 from operational_governance.change_policy_versions where effective_to is null and verification_required), 0),
    ('operational_change:maintenance_evidence', to_regclass('operational_governance.maintenance_events') is not null, 0)
  ) as checks(check_name, ready, issue_count);
$$;

insert into operational_governance.policy_versions (
  policy_id, command_type, version, approval_category, required_permission,
  break_glass_allowed, effective_from, content_hash
) values
  ('2fc02f00-5895-4c24-b64c-1ef13a341015', 'PRODUCT_PUBLICATION', 1, 'SINGLE_APPROVAL', 'system.admin', false, '2026-01-01', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532015'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341016', 'PROVIDER_ACTIVATION', 1, 'DUAL_APPROVAL', 'system.admin', false, '2026-01-01', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532016'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341017', 'PROVIDER_DEACTIVATION', 1, 'SINGLE_APPROVAL', 'system.admin', true, '2026-01-01', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532017'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341018', 'DRAW_SCHEDULE_PUBLICATION', 1, 'SINGLE_APPROVAL', 'system.admin', false, '2026-01-01', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532018'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341019', 'PLATFORM_MAINTENANCE', 1, 'SINGLE_APPROVAL', 'system.admin', true, '2026-01-01', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532019'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341020', 'RECOVERY_EXECUTION', 1, 'SINGLE_APPROVAL', 'system.admin', true, '2026-01-01', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532020'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341021', 'PRODUCTION_RELEASE', 1, 'DUAL_APPROVAL', 'system.admin', false, '2026-01-01', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532021');

insert into operational_governance.security_policy_versions (
  security_policy_id, command_type, version, mfa_required,
  privileged_session_required, minimum_human_approvals, requester_may_approve,
  approver_may_execute, requester_may_execute, break_glass_allowed,
  ticket_reference_required, maximum_session_minutes, effective_from, content_hash
) values
  ('85ab5600-8075-49a8-b8b4-35afeaa61015', 'PRODUCT_PUBLICATION', 1, true, true, 1, false, false, true, false, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111015'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61016', 'PROVIDER_ACTIVATION', 1, true, true, 2, false, false, true, false, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111016'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61017', 'PROVIDER_DEACTIVATION', 1, true, true, 1, false, false, true, true, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111017'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61018', 'DRAW_SCHEDULE_PUBLICATION', 1, true, true, 1, false, false, true, false, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111018'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61019', 'PLATFORM_MAINTENANCE', 1, true, true, 1, false, false, true, true, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111019'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61020', 'RECOVERY_EXECUTION', 1, true, true, 1, false, false, true, true, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111020'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61021', 'PRODUCTION_RELEASE', 1, true, true, 2, false, false, true, false, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111021');

insert into operational_governance.change_policy_versions (
  change_policy_id, change_type, version, operational_command_types,
  verification_required, authority_acceptance_required, readiness_required,
  audit_required, retry_allowed, maximum_attempts, effective_from, content_hash
) values
  ('41c71919-7d2e-427d-8c44-631ed6340001', 'CONFIGURATION_PUBLICATION', 1, array['CONFIGURATION_PUBLICATION'], true, true, true, true, true, 3, '2026-01-01', 'sha256:2222222222222222222222222222222222222222222222222222222222222001'),
  ('41c71919-7d2e-427d-8c44-631ed6340002', 'PRODUCT_PUBLICATION', 1, array['PRODUCT_PUBLICATION'], true, true, true, true, true, 3, '2026-01-01', 'sha256:2222222222222222222222222222222222222222222222222222222222222002'),
  ('41c71919-7d2e-427d-8c44-631ed6340003', 'PROVIDER_ACTIVATION', 1, array['PROVIDER_ACTIVATION','AUTHORITY_PROMOTION_EXECUTION','GAME_ENGINE_PRODUCTION_ACTIVATION'], true, true, true, true, true, 3, '2026-01-01', 'sha256:2222222222222222222222222222222222222222222222222222222222222003'),
  ('41c71919-7d2e-427d-8c44-631ed6340004', 'PROVIDER_DEACTIVATION', 1, array['PROVIDER_DEACTIVATION'], true, true, true, true, true, 3, '2026-01-01', 'sha256:2222222222222222222222222222222222222222222222222222222222222004'),
  ('41c71919-7d2e-427d-8c44-631ed6340005', 'DRAW_SCHEDULE_PUBLICATION', 1, array['DRAW_SCHEDULE_PUBLICATION'], true, true, true, true, true, 3, '2026-01-01', 'sha256:2222222222222222222222222222222222222222222222222222222222222005'),
  ('41c71919-7d2e-427d-8c44-631ed6340006', 'PLATFORM_MAINTENANCE', 1, array['PLATFORM_MAINTENANCE','PLATFORM_LIFECYCLE'], true, true, true, true, true, 3, '2026-01-01', 'sha256:2222222222222222222222222222222222222222222222222222222222222006'),
  ('41c71919-7d2e-427d-8c44-631ed6340007', 'RECOVERY_EXECUTION', 1, array['RECOVERY_EXECUTION','OUTCOME_RECOVERY_EXECUTION'], true, true, true, true, true, 5, '2026-01-01', 'sha256:2222222222222222222222222222222222222222222222222222222222222007'),
  ('41c71919-7d2e-427d-8c44-631ed6340008', 'PRODUCTION_RELEASE', 1, array['PRODUCTION_RELEASE'], true, true, true, true, true, 3, '2026-01-01', 'sha256:2222222222222222222222222222222222222222222222222222222222222008');

comment on table operational_governance.change_requests is
  'Canonical BF-6.3 production change authority: immutable request, execution, verification, and audit lineage.';
