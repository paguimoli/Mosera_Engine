create table game_engine.certification_packs (
  id uuid primary key,
  certification_pack_id text not null,
  certification_version text not null,
  game_manifest_id uuid not null,
  game_manifest_reference text not null,
  game_manifest_hash text not null,
  outcome_strategy_id text not null,
  outcome_strategy_version text not null,
  outcome_strategy_hash text not null,
  rng_provider_id text not null,
  rng_provider_version text not null,
  rng_provider_hash text not null,
  math_model_id text not null,
  math_model_version text not null,
  math_model_hash text not null,
  paytable_id text not null,
  paytable_version text not null,
  paytable_hash text not null,
  outcome_certificate_ids uuid[] not null,
  outcome_certificate_hashes text[] not null,
  math_evaluation_certificate_ids uuid[] not null,
  math_evaluation_hashes text[] not null,
  source_build_metadata jsonb not null default '{}'::jsonb,
  sbom_image_digest_references jsonb not null default '{}'::jsonb,
  jurisdiction_profile_references jsonb,
  certification_state text not null default 'None',
  canonical_json jsonb not null,
  hash_chain_root text not null,
  evidence_index jsonb not null default '{}'::jsonb,
  replay_fixture_references jsonb not null default '[]'::jsonb,
  content_hash text not null,
  signing_metadata jsonb,
  created_at timestamptz not null default now(),
  constraint ux_certification_packs_pack_version unique (certification_pack_id, certification_version),
  constraint ux_certification_packs_content_hash unique (content_hash),
  check (cardinality(outcome_certificate_ids) > 0),
  check (cardinality(outcome_certificate_ids) = cardinality(outcome_certificate_hashes)),
  check (cardinality(math_evaluation_certificate_ids) > 0),
  check (cardinality(math_evaluation_certificate_ids) = cardinality(math_evaluation_hashes)),
  check (jsonb_typeof(source_build_metadata) = 'object'),
  check (jsonb_typeof(sbom_image_digest_references) = 'object'),
  check (jurisdiction_profile_references is null or jsonb_typeof(jurisdiction_profile_references) = 'array'),
  check (certification_state in ('None', 'InternalVerified', 'LabSubmitted', 'Certified')),
  check (jsonb_typeof(canonical_json) = 'object'),
  check (jsonb_typeof(evidence_index) = 'object'),
  check (jsonb_typeof(replay_fixture_references) = 'array'),
  check (signing_metadata is null or jsonb_typeof(signing_metadata) = 'object'),
  check (hash_chain_root like 'sha256:%'),
  check (content_hash like 'sha256:%'),
  check (content_hash = hash_chain_root)
);

create index idx_certification_packs_pack_version
  on game_engine.certification_packs(certification_pack_id, certification_version);

create index idx_certification_packs_content_hash
  on game_engine.certification_packs(content_hash);

create index idx_certification_packs_game_manifest
  on game_engine.certification_packs(game_manifest_id, game_manifest_hash);

create index idx_certification_packs_certification_state
  on game_engine.certification_packs(certification_state);

create or replace function game_engine.validate_certification_pack()
returns trigger
language plpgsql
as $$
declare
  outcome_reference_count integer;
  math_reference_count integer;
begin
  if not exists (
    select 1
    from game_engine.game_manifests
    where id = new.game_manifest_id
      and content_hash = new.game_manifest_hash
  ) then
    raise exception 'Game manifest reference is invalid';
  end if;

  if not exists (
    select 1
    from game_engine.outcome_strategy_definitions
    where strategy_id = new.outcome_strategy_id
      and strategy_version = new.outcome_strategy_version
      and content_hash = new.outcome_strategy_hash
  ) then
    raise exception 'Outcome strategy reference is invalid';
  end if;

  if not exists (
    select 1
    from game_engine.rng_provider_definitions
    where provider_id = new.rng_provider_id
      and provider_version = new.rng_provider_version
      and content_hash = new.rng_provider_hash
  ) then
    raise exception 'RNG provider reference is invalid';
  end if;

  if not exists (
    select 1
    from game_engine.math_model_definitions
    where math_model_id = new.math_model_id
      and version = new.math_model_version
      and content_hash = new.math_model_hash
  ) then
    raise exception 'Math model reference is invalid';
  end if;

  if not exists (
    select 1
    from game_engine.paytable_definitions
    where paytable_id = new.paytable_id
      and version = new.paytable_version
      and content_hash = new.paytable_hash
      and math_model_id = new.math_model_id
      and math_model_version = new.math_model_version
  ) then
    raise exception 'Paytable reference is invalid';
  end if;

  select count(*)
    into outcome_reference_count
  from unnest(new.outcome_certificate_ids, new.outcome_certificate_hashes) as refs(certificate_id, certificate_hash)
  join game_engine.outcome_certificates certificates
    on certificates.certificate_id = refs.certificate_id
   and certificates.canonical_outcome_hash = refs.certificate_hash
   and certificates.strategy_id = new.outcome_strategy_id
   and certificates.strategy_version = new.outcome_strategy_version
   and certificates.rng_provider_id = new.rng_provider_id
   and certificates.rng_provider_version = new.rng_provider_version;

  if outcome_reference_count <> cardinality(new.outcome_certificate_ids) then
    raise exception 'Outcome certificate references are invalid';
  end if;

  select count(*)
    into math_reference_count
  from unnest(new.math_evaluation_certificate_ids, new.math_evaluation_hashes) as refs(certificate_id, certificate_hash)
  join game_engine.math_evaluation_certificates certificates
    on certificates.certificate_id = refs.certificate_id
   and certificates.canonical_prize_facts_hash = refs.certificate_hash
   and certificates.math_model_id = new.math_model_id
   and certificates.math_model_version = new.math_model_version
   and certificates.math_model_hash = new.math_model_hash
   and certificates.paytable_id = new.paytable_id
   and certificates.paytable_version = new.paytable_version
   and certificates.paytable_hash = new.paytable_hash;

  if math_reference_count <> cardinality(new.math_evaluation_certificate_ids) then
    raise exception 'Math evaluation certificate references are invalid';
  end if;

  if new.canonical_json->>'hashChainRoot' is distinct from new.hash_chain_root then
    raise exception 'Canonical export hashChainRoot must match certification pack hash_chain_root';
  end if;

  if new.canonical_json->>'certificationPackId' is distinct from new.certification_pack_id then
    raise exception 'Canonical export certificationPackId must match certification pack id';
  end if;

  if new.canonical_json->>'certificationVersion' is distinct from new.certification_version then
    raise exception 'Canonical export certificationVersion must match certification version';
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_certification_pack_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.certification_packs is append-only; create a new certification pack version instead';
end;
$$;

create trigger trg_validate_certification_pack
before insert on game_engine.certification_packs
for each row execute function game_engine.validate_certification_pack();

create trigger trg_prevent_certification_pack_update
before update on game_engine.certification_packs
for each row execute function game_engine.prevent_certification_pack_mutation();

create trigger trg_prevent_certification_pack_delete
before delete on game_engine.certification_packs
for each row execute function game_engine.prevent_certification_pack_mutation();

comment on table game_engine.certification_packs is
  'Append-only Certification Pack v1 authority-chain exports. Production signing remains disabled; signing metadata is a placeholder.';

comment on column game_engine.certification_packs.jurisdiction_profile_references is
  'Optional jurisdiction policy overlay references. Absence of jurisdiction does not invalidate the base certification pack.';
