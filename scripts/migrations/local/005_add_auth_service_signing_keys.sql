create table if not exists auth_service.signing_keys (
  id uuid primary key,
  key_id text not null unique,
  algorithm text not null,
  public_jwk jsonb not null,
  private_key_material_ref text not null,
  status text not null,
  version integer not null,
  created_at timestamptz not null default now(),
  activates_at timestamptz not null,
  expires_at timestamptz,
  retired_at timestamptz,
  check (version > 0),
  check (status in ('PLANNED', 'ACTIVE', 'ROTATING', 'RETIRED', 'REVOKED'))
);

create index if not exists idx_auth_signing_keys_active
  on auth_service.signing_keys(status, activates_at, expires_at)
  where retired_at is null;
