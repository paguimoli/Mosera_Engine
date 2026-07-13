create table game_engine.provably_fair_provider_definitions (
  id uuid primary key,
  provider_id text not null,
  provider_version text not null,
  outcome_provider_id text not null,
  outcome_provider_version text not null,
  commit_algorithm text not null,
  verification_algorithm text not null,
  hash_algorithm text not null,
  server_seed_policy jsonb not null default '{}'::jsonb,
  client_seed_policy jsonb not null default '{}'::jsonb,
  nonce_policy jsonb not null default '{}'::jsonb,
  reveal_policy jsonb not null default '{}'::jsonb,
  commitment_lifetime_seconds integer not null,
  receipt_support boolean not null default false,
  production_eligible boolean not null default false,
  lifecycle_state text not null,
  content_hash text not null,
  certification_binding text,
  jurisdiction_profile_references jsonb,
  created_at timestamptz not null default now(),
  constraint ux_provably_fair_provider_definitions_provider_version unique (provider_id, provider_version),
  constraint ux_provably_fair_provider_definitions_content_hash unique (content_hash),
  check (commit_algorithm in ('HASH_COMMITMENT')),
  check (verification_algorithm in ('HMAC_SHA_256', 'HMAC_SHA_384', 'HMAC_SHA_512')),
  check (hash_algorithm in ('SHA_256', 'SHA_384', 'SHA_512')),
  check (jsonb_typeof(server_seed_policy) = 'object'),
  check (jsonb_typeof(client_seed_policy) = 'object'),
  check (jsonb_typeof(nonce_policy) = 'object'),
  check (jsonb_typeof(reveal_policy) = 'object'),
  check (commitment_lifetime_seconds > 0),
  check (lifecycle_state in ('Draft', 'Active', 'Suspended', 'Retired', 'Superseded')),
  check (content_hash like 'sha256:%' or content_hash like 'sha384:%' or content_hash like 'sha512:%'),
  check (jurisdiction_profile_references is null or jsonb_typeof(jurisdiction_profile_references) = 'array')
);

create table game_engine.provably_fair_seed_commitments (
  seed_id uuid primary key,
  provider_id text not null,
  provider_version text not null,
  seed_generation_timestamp timestamptz not null,
  commitment_hash text not null,
  seed_lifecycle text not null,
  rotation_policy jsonb not null default '{}'::jsonb,
  activation_timestamp timestamptz,
  retirement_timestamp timestamptz,
  content_hash text not null,
  created_at timestamptz not null default now(),
  constraint ux_provably_fair_seed_commitments_hash unique (commitment_hash),
  constraint ux_provably_fair_seed_commitments_content_hash unique (content_hash),
  check (commitment_hash like 'sha256:%' or commitment_hash like 'sha384:%' or commitment_hash like 'sha512:%'),
  check (seed_lifecycle in ('Committed', 'Active', 'Retired', 'Revealed', 'Superseded', 'Disputed')),
  check (jsonb_typeof(rotation_policy) = 'object'),
  check (content_hash like 'sha256:%' or content_hash like 'sha384:%' or content_hash like 'sha512:%')
);

create table game_engine.provably_fair_nonce_sequences (
  id uuid primary key,
  provider_id text not null,
  provider_version text not null,
  provider_scope text not null,
  scope_type text not null,
  nonce bigint not null,
  nonce_policy jsonb not null default '{}'::jsonb,
  monotonic_required boolean not null default true,
  uniqueness_scope text not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  constraint ux_provably_fair_nonce_sequences_nonce unique (provider_id, provider_version, provider_scope, scope_type, uniqueness_scope, nonce),
  constraint ux_provably_fair_nonce_sequences_content_hash unique (content_hash),
  check (scope_type in ('Wager', 'Draw')),
  check (nonce >= 0),
  check (jsonb_typeof(nonce_policy) = 'object'),
  check (content_hash like 'sha256:%' or content_hash like 'sha384:%' or content_hash like 'sha512:%')
);

create table game_engine.provably_fair_verification_receipts (
  receipt_id uuid primary key,
  wager_reference text not null,
  outcome_certificate_id uuid not null,
  outcome_certificate_hash text not null,
  provider_id text not null,
  provider_version text not null,
  server_commitment text not null,
  client_seed text not null,
  nonce bigint not null,
  revealed_server_seed_placeholder text,
  verification_algorithm text not null,
  canonical_verification_payload jsonb not null default '{}'::jsonb,
  verification_status text not null,
  receipt_hash text not null,
  receipt_signature jsonb,
  qr_export_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ux_provably_fair_verification_receipts_hash unique (receipt_hash),
  constraint ux_provably_fair_verification_receipts_wager_provider unique (wager_reference, provider_id, provider_version, nonce),
  check (outcome_certificate_hash like 'sha256:%' or outcome_certificate_hash like 'sha384:%' or outcome_certificate_hash like 'sha512:%'),
  check (server_commitment like 'sha256:%' or server_commitment like 'sha384:%' or server_commitment like 'sha512:%'),
  check (nonce >= 0),
  check (verification_algorithm in ('HMAC_SHA_256', 'HMAC_SHA_384', 'HMAC_SHA_512')),
  check (jsonb_typeof(canonical_verification_payload) = 'object'),
  check (verification_status in ('PendingReveal', 'Verified', 'Failed', 'Disputed', 'Superseded')),
  check (receipt_hash like 'sha256:%' or receipt_hash like 'sha384:%' or receipt_hash like 'sha512:%'),
  check (receipt_signature is null or jsonb_typeof(receipt_signature) = 'object'),
  check (jsonb_typeof(qr_export_payload) = 'object')
);

create index idx_provably_fair_provider_definitions_provider_version
  on game_engine.provably_fair_provider_definitions(provider_id, provider_version);

create index idx_provably_fair_provider_definitions_outcome_provider
  on game_engine.provably_fair_provider_definitions(outcome_provider_id, outcome_provider_version);

create index idx_provably_fair_provider_definitions_content_hash
  on game_engine.provably_fair_provider_definitions(content_hash);

create index idx_provably_fair_provider_definitions_lifecycle_eligible
  on game_engine.provably_fair_provider_definitions(lifecycle_state, production_eligible);

create index idx_provably_fair_seed_commitments_provider_version
  on game_engine.provably_fair_seed_commitments(provider_id, provider_version);

create index idx_provably_fair_seed_commitments_commitment
  on game_engine.provably_fair_seed_commitments(commitment_hash);

create index idx_provably_fair_seed_commitments_lifecycle
  on game_engine.provably_fair_seed_commitments(seed_lifecycle);

create index idx_provably_fair_nonce_sequences_scope
  on game_engine.provably_fair_nonce_sequences(provider_id, provider_version, provider_scope, scope_type, uniqueness_scope);

create index idx_provably_fair_nonce_sequences_content_hash
  on game_engine.provably_fair_nonce_sequences(content_hash);

create index idx_provably_fair_verification_receipts_provider
  on game_engine.provably_fair_verification_receipts(provider_id, provider_version);

create index idx_provably_fair_verification_receipts_outcome_certificate
  on game_engine.provably_fair_verification_receipts(outcome_certificate_id, outcome_certificate_hash);

create index idx_provably_fair_verification_receipts_wager
  on game_engine.provably_fair_verification_receipts(wager_reference);

create index idx_provably_fair_verification_receipts_hash
  on game_engine.provably_fair_verification_receipts(receipt_hash);

create or replace function game_engine.jsonb_has_forbidden_seed_material(payload jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  item record;
begin
  if payload is null then
    return false;
  end if;

  if jsonb_typeof(payload) = 'object' then
    for item in select key, value from jsonb_each(payload)
    loop
      if lower(item.key) like '%serverseed%'
        or lower(item.key) like '%plaintextseed%'
        or lower(item.key) like '%rawseed%'
        or lower(item.key) like '%seedmaterial%'
        or lower(item.key) like '%secretseed%' then
        return true;
      end if;

      if game_engine.jsonb_has_forbidden_seed_material(item.value) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(payload) = 'array' then
    for item in select value from jsonb_array_elements(payload)
    loop
      if game_engine.jsonb_has_forbidden_seed_material(item.value) then
        return true;
      end if;
    end loop;
  end if;

  return false;
end;
$$;

create or replace function game_engine.validate_provably_fair_provider_definition()
returns trigger
language plpgsql
as $$
declare
  outcome_provider record;
begin
  select *
    into outcome_provider
  from game_engine.outcome_provider_definitions
  where provider_id = new.outcome_provider_id
    and provider_version = new.outcome_provider_version;

  if not found then
    raise exception 'Provably Fair contract references an unknown Outcome Provider version';
  end if;

  if outcome_provider.provider_type <> 'PROVABLY_FAIR' then
    raise exception 'Provably Fair contract must reference a PROVABLY_FAIR Outcome Provider';
  end if;

  if new.production_eligible and outcome_provider.production_eligible is not true then
    raise exception 'Production Provably Fair provider requires a production-eligible Outcome Provider';
  end if;

  if new.receipt_support is not true then
    raise exception 'Provably Fair providers must support player verification receipts';
  end if;

  if not (new.client_seed_policy ? 'required')
    or not (new.client_seed_policy ? 'maximumLength')
    or not (new.client_seed_policy ? 'allowedEncoding')
    or not (new.client_seed_policy ? 'canonicalizationRules') then
    raise exception 'Client seed policy is incomplete';
  end if;

  if (new.client_seed_policy ->> 'maximumLength')::integer <= 0 then
    raise exception 'Client seed maximum length must be positive';
  end if;

  if not (new.nonce_policy ? 'scopeType')
    or not (new.nonce_policy ? 'monotonicRequired')
    or not (new.nonce_policy ? 'uniquenessScope') then
    raise exception 'Nonce policy is incomplete';
  end if;

  if not (new.reveal_policy ? 'revealDelaySeconds')
    or not (new.reveal_policy ? 'revealWindowSeconds') then
    raise exception 'Reveal policy is incomplete';
  end if;

  if (new.reveal_policy ->> 'revealWindowSeconds')::integer < 0
    or (new.reveal_policy ->> 'revealDelaySeconds')::integer < 0 then
    raise exception 'Reveal windows and delays cannot be negative';
  end if;

  if game_engine.jsonb_has_forbidden_seed_material(new.server_seed_policy)
    or game_engine.jsonb_has_forbidden_seed_material(new.client_seed_policy)
    or game_engine.jsonb_has_forbidden_seed_material(new.nonce_policy)
    or game_engine.jsonb_has_forbidden_seed_material(new.reveal_policy) then
    raise exception 'Provably Fair governance must not persist plaintext server seed material';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_provably_fair_seed_commitment()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from game_engine.provably_fair_provider_definitions
    where provider_id = new.provider_id
      and provider_version = new.provider_version
  ) then
    raise exception 'Seed commitment references an unknown Provably Fair provider version';
  end if;

  if new.activation_timestamp is not null
    and new.activation_timestamp < new.seed_generation_timestamp then
    raise exception 'Seed activation cannot precede seed generation';
  end if;

  if new.retirement_timestamp is not null
    and new.activation_timestamp is not null
    and new.retirement_timestamp < new.activation_timestamp then
    raise exception 'Seed retirement cannot precede activation';
  end if;

  if game_engine.jsonb_has_forbidden_seed_material(new.rotation_policy) then
    raise exception 'Seed commitment governance must not persist plaintext server seed material';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_provably_fair_nonce_sequence()
returns trigger
language plpgsql
as $$
declare
  max_nonce bigint;
begin
  if not exists (
    select 1
    from game_engine.provably_fair_provider_definitions
    where provider_id = new.provider_id
      and provider_version = new.provider_version
  ) then
    raise exception 'Nonce sequence references an unknown Provably Fair provider version';
  end if;

  if new.monotonic_required then
    select max(nonce)
      into max_nonce
    from game_engine.provably_fair_nonce_sequences
    where provider_id = new.provider_id
      and provider_version = new.provider_version
      and provider_scope = new.provider_scope
      and scope_type = new.scope_type
      and uniqueness_scope = new.uniqueness_scope;

    if max_nonce is not null and new.nonce <= max_nonce then
      raise exception 'Provably Fair nonce cannot repeat or decrement';
    end if;
  end if;

  if game_engine.jsonb_has_forbidden_seed_material(new.nonce_policy) then
    raise exception 'Nonce governance must not persist plaintext server seed material';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_provably_fair_verification_receipt()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from game_engine.provably_fair_provider_definitions
    where provider_id = new.provider_id
      and provider_version = new.provider_version
      and receipt_support = true
  ) then
    raise exception 'Verification receipt references an unknown or receipt-disabled Provably Fair provider version';
  end if;

  if not exists (
    select 1
    from game_engine.outcome_certificates
    where certificate_id = new.outcome_certificate_id
      and canonical_outcome_hash = new.outcome_certificate_hash
  ) then
    raise exception 'Verification receipt requires a valid Outcome Certificate reference';
  end if;

  if not exists (
    select 1
    from game_engine.provably_fair_seed_commitments
    where provider_id = new.provider_id
      and provider_version = new.provider_version
      and commitment_hash = new.server_commitment
  ) then
    raise exception 'Verification receipt requires a valid server commitment';
  end if;

  if new.revealed_server_seed_placeholder is not null
    and (
      lower(new.revealed_server_seed_placeholder) like '%plaintext%'
      or lower(new.revealed_server_seed_placeholder) like '%serverseed%'
      or lower(new.revealed_server_seed_placeholder) like '%rawseed%'
    ) then
    raise exception 'Receipts must not expose unrevealed server seed material';
  end if;

  if game_engine.jsonb_has_forbidden_seed_material(new.canonical_verification_payload)
    or game_engine.jsonb_has_forbidden_seed_material(new.qr_export_payload) then
    raise exception 'Verification receipts must not persist plaintext server seed material';
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_provably_fair_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Provably Fair governance tables are append-only; create a new version, commitment, nonce, or receipt row instead';
end;
$$;

create trigger trg_validate_provably_fair_provider_definition
before insert on game_engine.provably_fair_provider_definitions
for each row execute function game_engine.validate_provably_fair_provider_definition();

create trigger trg_prevent_provably_fair_provider_update
before update on game_engine.provably_fair_provider_definitions
for each row execute function game_engine.prevent_provably_fair_mutation();

create trigger trg_prevent_provably_fair_provider_delete
before delete on game_engine.provably_fair_provider_definitions
for each row execute function game_engine.prevent_provably_fair_mutation();

create trigger trg_validate_provably_fair_seed_commitment
before insert on game_engine.provably_fair_seed_commitments
for each row execute function game_engine.validate_provably_fair_seed_commitment();

create trigger trg_prevent_provably_fair_seed_update
before update on game_engine.provably_fair_seed_commitments
for each row execute function game_engine.prevent_provably_fair_mutation();

create trigger trg_prevent_provably_fair_seed_delete
before delete on game_engine.provably_fair_seed_commitments
for each row execute function game_engine.prevent_provably_fair_mutation();

create trigger trg_validate_provably_fair_nonce_sequence
before insert on game_engine.provably_fair_nonce_sequences
for each row execute function game_engine.validate_provably_fair_nonce_sequence();

create trigger trg_prevent_provably_fair_nonce_update
before update on game_engine.provably_fair_nonce_sequences
for each row execute function game_engine.prevent_provably_fair_mutation();

create trigger trg_prevent_provably_fair_nonce_delete
before delete on game_engine.provably_fair_nonce_sequences
for each row execute function game_engine.prevent_provably_fair_mutation();

create trigger trg_validate_provably_fair_verification_receipt
before insert on game_engine.provably_fair_verification_receipts
for each row execute function game_engine.validate_provably_fair_verification_receipt();

create trigger trg_prevent_provably_fair_receipt_update
before update on game_engine.provably_fair_verification_receipts
for each row execute function game_engine.prevent_provably_fair_mutation();

create trigger trg_prevent_provably_fair_receipt_delete
before delete on game_engine.provably_fair_verification_receipts
for each row execute function game_engine.prevent_provably_fair_mutation();

comment on table game_engine.provably_fair_provider_definitions is
  'Append-only Provably Fair provider governance contracts. Commit-reveal runtime, seed generation, and production gameplay are intentionally disabled.';

comment on table game_engine.provably_fair_seed_commitments is
  'Append-only server seed commitment governance. Plaintext server seeds are never persisted in governance tables.';

comment on table game_engine.provably_fair_nonce_sequences is
  'Append-only nonce governance with replay/decrement protection per provider, scope, and uniqueness scope.';

comment on table game_engine.provably_fair_verification_receipts is
  'Append-only player verification receipt contracts linked to Outcome Certificates without exposing unrevealed server seed material.';
