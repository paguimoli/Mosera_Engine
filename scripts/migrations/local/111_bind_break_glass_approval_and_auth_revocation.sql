alter table operational_governance.privileged_sessions
  add column authorization_command_id uuid references operational_governance.commands(command_id);

create index idx_privileged_sessions_authorization_command
  on operational_governance.privileged_sessions(authorization_command_id)
  where authorization_command_id is not null;

create or replace function operational_governance.break_glass_command_authorized(
  p_command_id uuid,
  p_requester_identity_id text
) returns boolean language sql stable as $$
  select exists (
    select 1
      from operational_governance.commands command
     where command.command_id = p_command_id
       and command.command_type = 'BREAK_GLASS_LIFECYCLE'
       and command.actor_identity_id = p_requester_identity_id
       and operational_governance.authorize_command(command.command_id)
       and exists (
         select 1
           from operational_governance.command_approvals approval
          where approval.command_id = command.command_id
            and approval.approval_source = 'HUMAN'
            and approval.decision = 'APPROVED'
            and approval.approver_identity_id <> command.actor_identity_id
       )
  );
$$;
