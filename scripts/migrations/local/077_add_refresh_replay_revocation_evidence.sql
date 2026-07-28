alter table auth_service.authentication_audit_evidence
  add column session_id uuid references auth_service.canonical_sessions(id),
  add column refresh_token_id uuid references auth_service.refresh_tokens(id),
  add column refresh_token_family_id uuid,
  add column device_metadata text,
  add column revocation_reason text;

create index idx_auth_audit_refresh_replay
  on auth_service.authentication_audit_evidence(refresh_token_family_id, occurred_at desc)
  where action = 'REFRESH_TOKEN_REPLAY';

alter table auth_service.authentication_audit_evidence
  add constraint ck_auth_refresh_replay_evidence
  check (
    action <> 'REFRESH_TOKEN_REPLAY'
    or (
      session_id is not null
      and refresh_token_id is not null
      and refresh_token_family_id is not null
      and revocation_reason is not null
    )
  );
