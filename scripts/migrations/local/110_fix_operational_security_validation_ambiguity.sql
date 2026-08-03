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
  validation_decision text;
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
    validation_decision := 'NOT_REQUIRED_NON_PRODUCTION';
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
      count(*) filter (where approvals.approval_source = 'HUMAN' and approvals.decision = 'APPROVED'),
      count(*) filter (where approvals.approval_source = 'HUMAN' and approvals.decision = 'APPROVED'
        and approvals.approver_identity_id = p_executor_identity_id)
    into approval_count, executor_approval_count
    from operational_governance.command_approvals approvals where approvals.command_id = p_command_id;
    if approval_count < policy.minimum_human_approvals then
      raise exception 'Required independent operational approvals are missing.';
    end if;
    if not policy.approver_may_execute and executor_approval_count > 0 then
      raise exception 'Separation of Duties violation: approver cannot execute the command.';
    end if;
    if not policy.requester_may_execute and command_record.actor_identity_id = p_executor_identity_id then
      raise exception 'Separation of Duties violation: requester cannot execute the command.';
    end if;
    validation_decision := 'AUTHORIZED';
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
    p_production_enforced, validation_decision, 'Canonical operational security validation.',
    command_record.correlation_id, command_record.causation_id,
    'sha256:' || encode(digest(command_record.command_id::text || ':' || p_executor_identity_id || ':' || validation_decision, 'sha256'), 'hex')
  ) returning * into inserted;
  return inserted;
end;
$$;
