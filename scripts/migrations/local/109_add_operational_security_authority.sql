create table operational_governance.security_policy_versions (
  security_policy_id uuid primary key,
  command_type text not null,
  version integer not null check (version > 0),
  mfa_required boolean not null,
  privileged_session_required boolean not null,
  minimum_human_approvals integer not null check (minimum_human_approvals between 0 and 2),
  requester_may_approve boolean not null default false,
  approver_may_execute boolean not null default false,
  requester_may_execute boolean not null default true,
  break_glass_allowed boolean not null default false,
  ticket_reference_required boolean not null default true,
  maximum_session_minutes integer not null check (maximum_session_minutes between 1 and 60),
  effective_from timestamptz not null,
  effective_to timestamptz,
  content_hash text not null unique check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (command_type, version),
  check (effective_to is null or effective_to > effective_from)
);

create unique index ux_operational_security_active_policy
  on operational_governance.security_policy_versions(command_type)
  where effective_to is null;

create table operational_governance.privileged_sessions (
  privileged_session_id uuid primary key,
  authentication_session_id text not null,
  identity_id text not null,
  identity_class text not null,
  session_kind text not null check (session_kind in ('PRIVILEGED', 'BREAK_GLASS')),
  mfa_evidence_id text not null,
  mfa_evidence_hash text not null check (mfa_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  reason text not null check (btrim(reason) <> ''),
  ticket_reference text not null check (btrim(ticket_reference) <> ''),
  correlation_id text not null,
  activated_at timestamptz not null,
  expires_at timestamptz not null,
  evidence_hash text not null unique check (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  check (expires_at > activated_at and expires_at <= activated_at + interval '60 minutes'),
  unique (authentication_session_id, evidence_hash)
);

create index idx_privileged_sessions_auth_session
  on operational_governance.privileged_sessions(authentication_session_id, expires_at desc);
create index idx_privileged_sessions_identity
  on operational_governance.privileged_sessions(identity_id, expires_at desc);

create table operational_governance.privileged_session_events (
  event_id uuid primary key,
  privileged_session_id uuid not null references operational_governance.privileged_sessions(privileged_session_id),
  sequence integer not null check (sequence > 0),
  event_type text not null check (event_type in (
    'ACTIVATED', 'RENEWED', 'EXPIRED', 'MANUAL_TERMINATED',
    'FORCED_TERMINATED', 'AUTH_SESSION_REVOKED'
  )),
  actor_identity_id text not null,
  reason text not null check (btrim(reason) <> ''),
  ticket_reference text not null check (btrim(ticket_reference) <> ''),
  correlation_id text not null,
  causation_id text,
  occurred_at timestamptz not null,
  effective_expires_at timestamptz,
  evidence_hash text not null unique check (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  unique (privileged_session_id, sequence)
);

create table operational_governance.security_validation_evidence (
  validation_id uuid primary key,
  command_id uuid not null unique references operational_governance.commands(command_id),
  security_policy_id uuid not null references operational_governance.security_policy_versions(security_policy_id),
  security_policy_version integer not null,
  privileged_session_id uuid references operational_governance.privileged_sessions(privileged_session_id),
  requester_identity_id text not null,
  executor_identity_id text not null,
  mfa_verified boolean not null,
  session_verified boolean not null,
  scope_verified boolean not null,
  permission_verified boolean not null,
  approval_verified boolean not null,
  separation_of_duties_verified boolean not null,
  break_glass boolean not null,
  production_enforced boolean not null,
  decision text not null check (decision in ('AUTHORIZED', 'DENIED', 'NOT_REQUIRED_NON_PRODUCTION')),
  reason text not null,
  correlation_id text not null,
  causation_id text,
  evidence_hash text not null unique check (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  validated_at timestamptz not null default now()
);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'security_policy_versions', 'privileged_sessions',
    'privileged_session_events', 'security_validation_evidence'
  ] loop
    execute format(
      'create trigger %I before update or delete on operational_governance.%I for each row execute function operational_governance.prevent_immutable_mutation()',
      'trg_' || table_name || '_immutable', table_name
    );
  end loop;
end;
$$;

create or replace function operational_governance.prevent_approval_sod_violation()
returns trigger language plpgsql as $$
declare command_record operational_governance.commands%rowtype;
declare policy operational_governance.security_policy_versions%rowtype;
begin
  select * into command_record from operational_governance.commands where command_id = new.command_id;
  if not found then raise exception 'Operational command not found.'; end if;
  select * into policy from operational_governance.security_policy_versions
   where command_type = command_record.command_type and effective_from <= now()
     and (effective_to is null or effective_to > now()) order by version desc limit 1;
  if not found then raise exception 'Operational security policy unavailable.'; end if;
  if new.approval_source = 'HUMAN' and not policy.requester_may_approve
     and new.approver_identity_id = command_record.actor_identity_id then
    raise exception 'Separation of Duties violation: requester cannot approve the command.';
  end if;
  if command_record.break_glass and new.approver_identity_id = command_record.actor_identity_id then
    raise exception 'Separation of Duties violation: break-glass requester cannot approve the command.';
  end if;
  return new;
end;
$$;

create trigger trg_command_approvals_sod
before insert on operational_governance.command_approvals
for each row execute function operational_governance.prevent_approval_sod_violation();

create or replace function operational_governance.privileged_session_active(
  p_privileged_session_id uuid,
  p_authentication_session_id text,
  p_identity_id text,
  p_at timestamptz default now()
) returns boolean language sql stable as $$
  select exists (
    select 1 from operational_governance.privileged_sessions session
    where session.privileged_session_id = p_privileged_session_id
      and session.authentication_session_id = p_authentication_session_id
      and session.identity_id = p_identity_id
      and session.activated_at <= p_at and session.expires_at > p_at
      and not exists (
        select 1 from operational_governance.privileged_session_events event
        where event.privileged_session_id = session.privileged_session_id
          and event.event_type in (
            'EXPIRED', 'MANUAL_TERMINATED', 'FORCED_TERMINATED', 'AUTH_SESSION_REVOKED'
          )
      )
  );
$$;

create or replace function operational_governance.validate_command_security(
  p_command_id uuid,
  p_privileged_session_id uuid,
  p_executor_identity_id text,
  p_production_enforced boolean
) returns operational_governance.security_validation_evidence
language plpgsql as $$
declare
  command_record operational_governance.commands%rowtype;
  policy operational_governance.security_policy_versions%rowtype;
  privileged_session operational_governance.privileged_sessions%rowtype;
  approval_count integer;
  executor_approval_count integer;
  decision text;
  inserted operational_governance.security_validation_evidence%rowtype;
begin
  select * into inserted from operational_governance.security_validation_evidence where command_id = p_command_id;
  if found then
    if p_production_enforced and (
      not inserted.production_enforced or inserted.decision <> 'AUTHORIZED'
      or inserted.executor_identity_id <> p_executor_identity_id
      or inserted.privileged_session_id is distinct from p_privileged_session_id
    ) then
      raise exception 'Existing operational security evidence does not authorize this production execution.';
    end if;
    return inserted;
  end if;
  select * into command_record from operational_governance.commands where command_id = p_command_id;
  if not found then raise exception 'Operational command not found.'; end if;
  select * into policy from operational_governance.security_policy_versions
   where command_type = command_record.command_type and effective_from <= now()
     and (effective_to is null or effective_to > now()) order by version desc limit 1;
  if not found then raise exception 'Operational security policy unavailable.'; end if;

  if not p_production_enforced then
    decision := 'NOT_REQUIRED_NON_PRODUCTION';
  else
    if command_record.actor_identity_id <> p_executor_identity_id then
      raise exception 'Privileged command executor must match the authenticated command identity.';
    end if;
    if policy.privileged_session_required and p_privileged_session_id is null then
      raise exception 'A privileged session is required.';
    end if;
    select * into privileged_session from operational_governance.privileged_sessions
     where privileged_session_id = p_privileged_session_id;
    if policy.privileged_session_required and (
      not found or not operational_governance.privileged_session_active(
        p_privileged_session_id, command_record.actor_session_id,
        command_record.actor_identity_id, now()
      )
    ) then raise exception 'Privileged session is missing, expired, or revoked.'; end if;
    if policy.mfa_required and btrim(coalesce(privileged_session.mfa_evidence_id, '')) = '' then
      raise exception 'Durable MFA verification evidence is required.';
    end if;
    if privileged_session.session_kind = 'BREAK_GLASS' and not policy.break_glass_allowed then
      raise exception 'Break-glass is not permitted for this command.';
    end if;
    select
      count(*) filter (where approval_source = 'HUMAN' and decision = 'APPROVED'),
      count(*) filter (where approval_source = 'HUMAN' and decision = 'APPROVED'
        and approver_identity_id = p_executor_identity_id)
    into approval_count, executor_approval_count
    from operational_governance.command_approvals where command_id = p_command_id;
    if approval_count < policy.minimum_human_approvals then
      raise exception 'Required independent operational approvals are missing.';
    end if;
    if not policy.approver_may_execute and executor_approval_count > 0 then
      raise exception 'Separation of Duties violation: approver cannot execute the command.';
    end if;
    if not policy.requester_may_execute and command_record.actor_identity_id = p_executor_identity_id then
      raise exception 'Separation of Duties violation: requester cannot execute the command.';
    end if;
    decision := 'AUTHORIZED';
  end if;

  insert into operational_governance.security_validation_evidence (
    validation_id, command_id, security_policy_id, security_policy_version,
    privileged_session_id, requester_identity_id, executor_identity_id,
    mfa_verified, session_verified, scope_verified, permission_verified,
    approval_verified, separation_of_duties_verified, break_glass,
    production_enforced, decision, reason, correlation_id, causation_id, evidence_hash
  ) values (
    gen_random_uuid(), command_record.command_id, policy.security_policy_id, policy.version,
    p_privileged_session_id, command_record.actor_identity_id, p_executor_identity_id,
    not policy.mfa_required or btrim(coalesce(privileged_session.mfa_evidence_id, '')) <> '',
    not policy.privileged_session_required or operational_governance.privileged_session_active(
      p_privileged_session_id, command_record.actor_session_id, command_record.actor_identity_id, now()
    ),
    true, true, not p_production_enforced or approval_count >= policy.minimum_human_approvals,
    true, coalesce(privileged_session.session_kind = 'BREAK_GLASS', false),
    p_production_enforced, decision, 'Canonical operational security validation.',
    command_record.correlation_id, command_record.causation_id,
    'sha256:' || encode(digest(command_record.command_id::text || ':' || p_executor_identity_id || ':' || decision, 'sha256'), 'hex')
  ) returning * into inserted;
  return inserted;
end;
$$;

insert into operational_governance.security_policy_versions (
  security_policy_id, command_type, version, mfa_required,
  privileged_session_required, minimum_human_approvals, requester_may_approve,
  approver_may_execute, requester_may_execute, break_glass_allowed,
  ticket_reference_required, maximum_session_minutes, effective_from, content_hash
) values
  ('85ab5600-8075-49a8-b8b4-35afeaa61001', 'AUTHORITY_APPROVAL_CAPTURE', 1, true, true, 0, false, false, true, false, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111001'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61002', 'AUTHORITY_CERTIFICATION_CAPTURE', 1, true, true, 1, false, false, true, false, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111002'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61003', 'AUTHORITY_PROMOTION_EXECUTION', 1, true, true, 1, false, false, true, false, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111003'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61004', 'PLATFORM_LIFECYCLE', 1, true, true, 0, false, false, true, false, true, 30, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111004'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61005', 'BREAK_GLASS_LIFECYCLE', 1, true, true, 1, false, false, true, false, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111005'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61006', 'SESSION_REVOCATION', 1, true, true, 0, false, false, true, true, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111006'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61007', 'LEDGER_REMEDIATION_APPROVAL_CAPTURE', 1, true, true, 0, false, false, true, false, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111007'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61008', 'POLICY_SINGLE_APPROVAL_QA', 1, true, true, 1, false, false, true, false, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111008'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61009', 'POLICY_DUAL_APPROVAL_QA', 1, true, true, 2, false, false, true, false, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111009'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61010', 'POLICY_SYSTEM_APPROVAL_QA', 1, true, true, 0, false, false, true, false, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111010'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61011', 'GAME_ENGINE_PRODUCTION_ACTIVATION', 1, true, true, 2, false, false, true, false, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111011'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61012', 'MANUAL_CERTIFIED_SUBMISSION', 1, true, true, 1, false, false, true, false, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111012'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61013', 'OUTCOME_RECOVERY_EXECUTION', 1, true, true, 1, false, false, true, true, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111013'),
  ('85ab5600-8075-49a8-b8b4-35afeaa61014', 'CONFIGURATION_PUBLICATION', 1, true, true, 1, false, false, true, false, true, 15, '2026-01-01', 'sha256:1111111111111111111111111111111111111111111111111111111111111014');

comment on table operational_governance.security_policy_versions is
  'Canonical BF-6.2 Separation-of-Duties, MFA, privileged-session, and break-glass policy catalog.';

insert into operational_governance.policy_versions (
  policy_id, command_type, version, approval_category, required_permission,
  break_glass_allowed, effective_from, content_hash
) values
  ('2fc02f00-5895-4c24-b64c-1ef13a341011', 'GAME_ENGINE_PRODUCTION_ACTIVATION', 1, 'DUAL_APPROVAL', 'system.admin', false, '2026-01-01', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532011'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341012', 'MANUAL_CERTIFIED_SUBMISSION', 1, 'SINGLE_APPROVAL', 'system.admin', false, '2026-01-01', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532012'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341013', 'OUTCOME_RECOVERY_EXECUTION', 1, 'SINGLE_APPROVAL', 'system.admin', true, '2026-01-01', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532013'),
  ('2fc02f00-5895-4c24-b64c-1ef13a341014', 'CONFIGURATION_PUBLICATION', 1, 'SINGLE_APPROVAL', 'system.admin', false, '2026-01-01', 'sha256:64dc540625f932255c52938d45bdb3f133bab8ce2712d963798b50997f532014');
