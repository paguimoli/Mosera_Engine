create schema if not exists operational_governance;

create table operational_governance.policy_versions (
  policy_id uuid primary key,
  command_type text not null,
  version integer not null check (version > 0),
  approval_category text not null check (approval_category in (
    'NO_APPROVAL', 'SINGLE_APPROVAL', 'DUAL_APPROVAL', 'SYSTEM_APPROVAL'
  )),
  required_permission text not null,
  break_glass_allowed boolean not null default false,
  effective_from timestamptz not null,
  effective_to timestamptz,
  content_hash text not null unique check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (command_type, version),
  check (effective_to is null or effective_to > effective_from)
);

create unique index ux_operational_governance_active_policy
  on operational_governance.policy_versions(command_type)
  where effective_to is null;

create table operational_governance.commands (
  command_id uuid primary key,
  command_type text not null,
  idempotency_key text not null unique,
  canonical_request_hash text not null check (canonical_request_hash ~ '^sha256:[0-9a-f]{64}$'),
  actor_identity_id text not null,
  actor_session_id text not null,
  actor_identity_class text not null,
  actor_roles jsonb not null,
  actor_permissions jsonb not null,
  scope_snapshot jsonb not null,
  reason text not null check (btrim(reason) <> ''),
  affected_authority text not null,
  target_type text not null,
  target_id text not null,
  correlation_id text not null,
  causation_id text,
  break_glass boolean not null default false,
  policy_id uuid not null references operational_governance.policy_versions(policy_id),
  policy_version integer not null,
  requested_at timestamptz not null default now()
);

create index idx_operational_commands_target
  on operational_governance.commands(affected_authority, target_type, target_id, requested_at desc);
create index idx_operational_commands_correlation
  on operational_governance.commands(correlation_id, requested_at desc);

create table operational_governance.command_approvals (
  approval_id uuid primary key,
  command_id uuid not null references operational_governance.commands(command_id),
  approver_identity_id text not null,
  approver_session_id text not null,
  approval_source text not null check (approval_source in ('HUMAN', 'SYSTEM')),
  decision text not null check (decision in ('APPROVED', 'REJECTED')),
  reason text not null check (btrim(reason) <> ''),
  evidence_hash text not null unique check (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  approved_at timestamptz not null default now(),
  unique (command_id, approver_identity_id, approval_source)
);

create table operational_governance.command_events (
  event_id uuid primary key,
  command_id uuid not null references operational_governance.commands(command_id),
  sequence integer not null check (sequence > 0),
  event_type text not null check (event_type in (
    'REQUESTED', 'AUTHORIZED', 'EXECUTION_STARTED', 'EXECUTION_SUCCEEDED',
    'EXECUTION_FAILED', 'RECOVERY_AUTHORIZED'
  )),
  actor_identity_id text not null,
  correlation_id text not null,
  causation_id text,
  metadata jsonb not null default '{}'::jsonb,
  evidence_hash text not null unique check (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  occurred_at timestamptz not null default now(),
  unique (command_id, sequence)
);

create table operational_governance.execution_evidence (
  evidence_id uuid primary key,
  command_id uuid not null references operational_governance.commands(command_id),
  attempt integer not null check (attempt > 0),
  result_status text not null check (result_status in ('SUCCEEDED', 'FAILED')),
  result_payload jsonb not null default '{}'::jsonb,
  result_hash text not null check (result_hash ~ '^sha256:[0-9a-f]{64}$'),
  failure_code text,
  failure_reason text,
  correlation_id text not null,
  causation_id text,
  recorded_at timestamptz not null default now(),
  unique (command_id, attempt),
  unique (command_id, result_hash)
);

create or replace function operational_governance.prevent_immutable_mutation()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only; correction requires new evidence', tg_table_name;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'policy_versions', 'commands', 'command_approvals', 'command_events', 'execution_evidence'
  ] loop
    execute format(
      'create trigger %I before update or delete on operational_governance.%I for each row execute function operational_governance.prevent_immutable_mutation()',
      'trg_' || table_name || '_immutable', table_name
    );
  end loop;
end;
$$;

create or replace function operational_governance.request_command(
  p_command_id uuid,
  p_command_type text,
  p_idempotency_key text,
  p_canonical_request_hash text,
  p_actor_identity_id text,
  p_actor_session_id text,
  p_actor_identity_class text,
  p_actor_roles jsonb,
  p_actor_permissions jsonb,
  p_scope_snapshot jsonb,
  p_reason text,
  p_affected_authority text,
  p_target_type text,
  p_target_id text,
  p_correlation_id text,
  p_causation_id text default null
) returns operational_governance.commands
language plpgsql as $$
declare
  existing operational_governance.commands%rowtype;
  policy operational_governance.policy_versions%rowtype;
  inserted operational_governance.commands%rowtype;
begin
  select * into existing
  from operational_governance.commands
  where idempotency_key = p_idempotency_key;

  if found then
    if existing.canonical_request_hash <> p_canonical_request_hash then
      raise exception 'Operational command idempotency conflict.' using errcode = '23505';
    end if;
    return existing;
  end if;

  select * into policy
  from operational_governance.policy_versions
  where command_type = p_command_type
    and effective_from <= now()
    and (effective_to is null or effective_to > now())
  order by version desc
  limit 1;

  if not found then
    raise exception 'No active operational policy for command type %.', p_command_type;
  end if;

  if not (
    p_actor_permissions ? 'system.admin'
    or p_actor_permissions ? policy.required_permission
    or (
      position('*' in policy.required_permission) > 0
      and exists (
        select 1 from jsonb_object_keys(p_actor_permissions) as permission_key
        where permission_key like replace(policy.required_permission, '*', '%')
      )
    )
  ) then
    raise exception 'Operational permission denied.';
  end if;

  if p_actor_identity_class = 'BREAK_GLASS' and not policy.break_glass_allowed then
    raise exception 'Break-glass use is not allowed by this operational policy.';
  end if;

  insert into operational_governance.commands (
    command_id, command_type, idempotency_key, canonical_request_hash,
    actor_identity_id, actor_session_id, actor_identity_class, actor_roles,
    actor_permissions, scope_snapshot, reason, affected_authority, target_type,
    target_id, correlation_id, causation_id, break_glass, policy_id, policy_version
  ) values (
    p_command_id, p_command_type, p_idempotency_key, p_canonical_request_hash,
    p_actor_identity_id, p_actor_session_id, p_actor_identity_class, p_actor_roles,
    p_actor_permissions, p_scope_snapshot, p_reason, p_affected_authority, p_target_type,
    p_target_id, p_correlation_id, p_causation_id,
    p_actor_identity_class = 'BREAK_GLASS', policy.policy_id, policy.version
  ) returning * into inserted;

  insert into operational_governance.command_events (
    event_id, command_id, sequence, event_type, actor_identity_id, correlation_id,
    causation_id, metadata, evidence_hash
  ) values (
    gen_random_uuid(), inserted.command_id, 1, 'REQUESTED', p_actor_identity_id,
    p_correlation_id, p_causation_id,
    jsonb_build_object('policyId', policy.policy_id, 'policyVersion', policy.version),
    'sha256:' || encode(digest(inserted.command_id::text || ':REQUESTED:1', 'sha256'), 'hex')
  );

  return inserted;
exception
  when unique_violation then
    select * into existing from operational_governance.commands
    where idempotency_key = p_idempotency_key;
    if found and existing.canonical_request_hash = p_canonical_request_hash then
      return existing;
    end if;
    raise exception 'Operational command idempotency conflict.' using errcode = '23505';
end;
$$;

create or replace function operational_governance.authorize_command(p_command_id uuid)
returns boolean language plpgsql as $$
declare
  command_record operational_governance.commands%rowtype;
  policy operational_governance.policy_versions%rowtype;
  human_approvals integer;
  system_approvals integer;
  rejected integer;
begin
  select * into command_record from operational_governance.commands where command_id = p_command_id;
  if not found then raise exception 'Operational command not found.'; end if;
  select * into policy from operational_governance.policy_versions where policy_id = command_record.policy_id;

  select
    count(*) filter (where decision = 'APPROVED' and approval_source = 'HUMAN'),
    count(*) filter (where decision = 'APPROVED' and approval_source = 'SYSTEM'),
    count(*) filter (where decision = 'REJECTED')
  into human_approvals, system_approvals, rejected
  from operational_governance.command_approvals where command_id = p_command_id;

  if rejected > 0 then raise exception 'Operational command approval was rejected.'; end if;
  if policy.approval_category = 'SINGLE_APPROVAL' and human_approvals < 1 then
    raise exception 'Single approval is required.';
  elsif policy.approval_category = 'DUAL_APPROVAL' and human_approvals < 2 then
    raise exception 'Two distinct human approvals are required.';
  elsif policy.approval_category = 'SYSTEM_APPROVAL' and system_approvals < 1 then
    raise exception 'System approval is required.';
  end if;
  return true;
end;
$$;

create or replace function operational_governance.readiness()
returns table(check_name text, ready boolean, issue_count integer)
language sql stable as $$
  select * from (values
    ('operational_governance:policy_catalog', exists(select 1 from operational_governance.policy_versions where effective_to is null), 0),
    ('operational_governance:immutable_commands', exists(select 1 from pg_trigger where tgname = 'trg_commands_immutable'), 0),
    ('operational_governance:immutable_approvals', exists(select 1 from pg_trigger where tgname = 'trg_command_approvals_immutable'), 0),
    ('operational_governance:immutable_audit', exists(select 1 from pg_trigger where tgname = 'trg_command_events_immutable'), 0),
    ('operational_governance:idempotency', exists(select 1 from pg_indexes where schemaname = 'operational_governance' and tablename = 'commands' and indexdef ilike '%idempotency_key%'), 0)
  ) as checks(check_name, ready, issue_count);
$$;

insert into operational_governance.policy_versions (
  policy_id, command_type, version, approval_category, required_permission,
  break_glass_allowed, effective_from, content_hash
) values
  ('2fc02f00-5895-4c24-b64c-1ef13a341001', 'AUTHORITY_APPROVAL_CAPTURE', 1, 'NO_APPROVAL', 'system.admin', false, '2026-01-01T00:00:00Z', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532001'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341002', 'AUTHORITY_CERTIFICATION_CAPTURE', 1, 'NO_APPROVAL', 'system.admin', false, '2026-01-01T00:00:00Z', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532002'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341003', 'AUTHORITY_PROMOTION_EXECUTION', 1, 'NO_APPROVAL', 'system.admin', false, '2026-01-01T00:00:00Z', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532003'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341004', 'PLATFORM_LIFECYCLE', 1, 'NO_APPROVAL', 'platform.*.create', false, '2026-01-01T00:00:00Z', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532004'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341005', 'BREAK_GLASS_LIFECYCLE', 1, 'NO_APPROVAL', 'system.admin', true, '2026-01-01T00:00:00Z', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532005'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341006', 'SESSION_REVOCATION', 1, 'NO_APPROVAL', 'system.admin', true, '2026-01-01T00:00:00Z', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532006'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341007', 'LEDGER_REMEDIATION_APPROVAL_CAPTURE', 1, 'NO_APPROVAL', 'system.admin', false, '2026-01-01T00:00:00Z', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532007'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341008', 'POLICY_SINGLE_APPROVAL_QA', 1, 'SINGLE_APPROVAL', 'system.admin', false, '2026-01-01T00:00:00Z', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532008'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341009', 'POLICY_DUAL_APPROVAL_QA', 1, 'DUAL_APPROVAL', 'system.admin', false, '2026-01-01T00:00:00Z', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532009'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341010', 'POLICY_SYSTEM_APPROVAL_QA', 1, 'SYSTEM_APPROVAL', 'system.admin', false, '2026-01-01T00:00:00Z', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532010');

comment on schema operational_governance is
  'Canonical BF-6.1 authority for immutable operational commands, policy-driven approvals, authorization, execution evidence, and audit.';
