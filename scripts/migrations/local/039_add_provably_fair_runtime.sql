create table game_engine.provably_fair_runtime_receipts (
  receipt_id uuid primary key,
  wager_reference text not null,
  outcome_certificate_id uuid not null,
  outcome_certificate_hash text not null,
  provider_id text not null,
  provider_version text not null,
  server_commitment text not null,
  client_seed text not null,
  nonce bigint not null,
  verification_algorithm text not null,
  canonical_verification_payload jsonb not null default '{}'::jsonb,
  resulting_outcome_hash text not null,
  verification_status text not null,
  reveal_state text not null,
  receipt_hash text not null,
  issued_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint ux_provably_fair_runtime_receipts_hash unique (receipt_hash),
  constraint ux_provably_fair_runtime_receipts_scope_nonce unique (provider_id, provider_version, wager_reference, nonce),
  check (outcome_certificate_hash like 'sha256:%' or outcome_certificate_hash like 'sha384:%' or outcome_certificate_hash like 'sha512:%'),
  check (server_commitment like 'sha256:%' or server_commitment like 'sha384:%' or server_commitment like 'sha512:%'),
  check (resulting_outcome_hash like 'sha256:%' or resulting_outcome_hash like 'sha384:%' or resulting_outcome_hash like 'sha512:%'),
  check (verification_algorithm in ('HMAC_SHA_256', 'HMAC_SHA_384', 'HMAC_SHA_512')),
  check (jsonb_typeof(canonical_verification_payload) = 'object'),
  check (verification_status in ('PendingReveal', 'Verified', 'Failed', 'Disputed', 'Superseded')),
  check (reveal_state in ('NotEligible', 'Eligible', 'Delayed', 'WindowOpen', 'Expired', 'Disputed', 'Superseded')),
  check (receipt_hash like 'sha256:%' or receipt_hash like 'sha384:%' or receipt_hash like 'sha512:%')
);

create table game_engine.provably_fair_seed_reveal_evidence (
  reveal_id uuid primary key,
  seed_id uuid not null,
  provider_id text not null,
  provider_version text not null,
  scope text not null,
  server_seed_hash text not null,
  commitment_hash text not null,
  reveal_status text not null,
  canonical_evidence_hash text not null,
  revealed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint ux_provably_fair_seed_reveal_evidence_hash unique (canonical_evidence_hash),
  check (server_seed_hash like 'sha256:%' or server_seed_hash like 'sha384:%' or server_seed_hash like 'sha512:%'),
  check (commitment_hash like 'sha256:%' or commitment_hash like 'sha384:%' or commitment_hash like 'sha512:%'),
  check (reveal_status in ('NotEligible', 'Eligible', 'Verified', 'Failed')),
  check (canonical_evidence_hash like 'sha256:%' or canonical_evidence_hash like 'sha384:%' or canonical_evidence_hash like 'sha512:%')
);

create table game_engine.provably_fair_verification_results (
  verification_id uuid primary key,
  receipt_id uuid not null,
  receipt_hash text not null,
  recomputed_commitment_hash text not null,
  recomputed_outcome_hash text not null,
  verification_status text not null,
  failure_reason text,
  canonical_result_hash text not null,
  verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint ux_provably_fair_verification_results_hash unique (canonical_result_hash),
  check (receipt_hash like 'sha256:%' or receipt_hash like 'sha384:%' or receipt_hash like 'sha512:%'),
  check (recomputed_commitment_hash like 'sha256:%' or recomputed_commitment_hash like 'sha384:%' or recomputed_commitment_hash like 'sha512:%'),
  check (recomputed_outcome_hash like 'sha256:%' or recomputed_outcome_hash like 'sha384:%' or recomputed_outcome_hash like 'sha512:%'),
  check (verification_status in ('NotEligible', 'Eligible', 'Verified', 'Failed')),
  check (canonical_result_hash like 'sha256:%' or canonical_result_hash like 'sha384:%' or canonical_result_hash like 'sha512:%')
);

create index idx_provably_fair_runtime_receipts_provider
  on game_engine.provably_fair_runtime_receipts(provider_id, provider_version);

create index idx_provably_fair_runtime_receipts_wager
  on game_engine.provably_fair_runtime_receipts(wager_reference);

create index idx_provably_fair_seed_reveal_evidence_seed
  on game_engine.provably_fair_seed_reveal_evidence(seed_id, provider_id, provider_version);

create index idx_provably_fair_verification_results_receipt
  on game_engine.provably_fair_verification_results(receipt_id, receipt_hash);

create or replace function game_engine.validate_provably_fair_runtime_receipt()
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
    raise exception 'Provably Fair runtime receipt references an unknown or receipt-disabled provider';
  end if;

  if not exists (
    select 1
    from game_engine.provably_fair_seed_commitments
    where provider_id = new.provider_id
      and provider_version = new.provider_version
      and commitment_hash = new.server_commitment
  ) then
    raise exception 'Provably Fair runtime receipt requires a published seed commitment';
  end if;

  if game_engine.jsonb_has_forbidden_seed_material(new.canonical_verification_payload) then
    raise exception 'Provably Fair runtime receipts must not persist plaintext server seed material';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_provably_fair_runtime_reveal()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from game_engine.provably_fair_seed_commitments
    where seed_id = new.seed_id
      and provider_id = new.provider_id
      and provider_version = new.provider_version
      and commitment_hash = new.commitment_hash
  ) then
    raise exception 'Provably Fair reveal evidence requires a matching seed commitment';
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_provably_fair_runtime_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Provably Fair runtime evidence is append-only';
end;
$$;

create trigger trg_validate_provably_fair_runtime_receipt
before insert on game_engine.provably_fair_runtime_receipts
for each row execute function game_engine.validate_provably_fair_runtime_receipt();

create trigger trg_prevent_provably_fair_runtime_receipt_update
before update on game_engine.provably_fair_runtime_receipts
for each row execute function game_engine.prevent_provably_fair_runtime_mutation();

create trigger trg_prevent_provably_fair_runtime_receipt_delete
before delete on game_engine.provably_fair_runtime_receipts
for each row execute function game_engine.prevent_provably_fair_runtime_mutation();

create trigger trg_validate_provably_fair_runtime_reveal
before insert on game_engine.provably_fair_seed_reveal_evidence
for each row execute function game_engine.validate_provably_fair_runtime_reveal();

create trigger trg_prevent_provably_fair_runtime_reveal_update
before update on game_engine.provably_fair_seed_reveal_evidence
for each row execute function game_engine.prevent_provably_fair_runtime_mutation();

create trigger trg_prevent_provably_fair_runtime_reveal_delete
before delete on game_engine.provably_fair_seed_reveal_evidence
for each row execute function game_engine.prevent_provably_fair_runtime_mutation();

create trigger trg_prevent_provably_fair_verification_result_update
before update on game_engine.provably_fair_verification_results
for each row execute function game_engine.prevent_provably_fair_runtime_mutation();

create trigger trg_prevent_provably_fair_verification_result_delete
before delete on game_engine.provably_fair_verification_results
for each row execute function game_engine.prevent_provably_fair_runtime_mutation();

create or replace function game_engine.validate_outcome_runtime_attempt()
returns trigger
language plpgsql
as $$
begin
  if lower(new.failure_reason) like '%rawseed%'
    or lower(new.failure_reason) like '%serverseed%'
    or lower(new.lock_scope) like '%rawseed%'
    or lower(new.lock_scope) like '%serverseed%' then
    raise exception 'Outcome runtime attempt evidence must not contain raw entropy, seed material, or DRBG state';
  end if;

  if new.status = 'Accepted'
    and not (
      new.provider_type in ('CERTIFIED_CSPRNG', 'PROVABLY_FAIR')
      and new.mode in ('DryRun', 'Simulation')
      and new.failure_code = 'None'
    ) then
    raise exception 'Only dry-run/simulation CSPRNG or Provably Fair attempts can be accepted while production authority remains disabled';
  end if;

  if new.mode = 'Production' then
    raise exception 'Production Outcome Provider runtime generation is disabled';
  end if;

  return new;
end;
$$;

comment on table game_engine.provably_fair_runtime_receipts is
  'Append-only internal Provably Fair runtime receipts. They omit plaintext server seed material until governed reveal verification.';

comment on table game_engine.provably_fair_seed_reveal_evidence is
  'Append-only governed Provably Fair seed reveal evidence storing hashes only, not plaintext seed material.';

comment on table game_engine.provably_fair_verification_results is
  'Append-only Provably Fair post-reveal verification results.';
