create table if not exists auth_service.refresh_tokens (
  id uuid primary key,
  identity_id uuid not null references auth_service.identities(id),
  session_id uuid not null references auth_service.sessions(id),
  token_id uuid not null references auth_service.tokens(id),
  family_id uuid not null,
  rotation_counter integer not null default 0,
  previous_refresh_token_id uuid references auth_service.refresh_tokens(id),
  opaque_reference_hash text not null unique,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  rotated_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  check (rotation_counter >= 0)
);

create index if not exists idx_auth_refresh_token_family
  on auth_service.refresh_tokens(family_id);

create index if not exists idx_auth_refresh_token_session
  on auth_service.refresh_tokens(session_id);

create index if not exists idx_auth_refresh_token_active_session
  on auth_service.refresh_tokens(session_id, expires_at)
  where revoked_at is null and rotated_at is null;
