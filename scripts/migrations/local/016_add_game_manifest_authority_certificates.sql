create table game_engine.game_manifests (
  id uuid primary key,
  game_id uuid not null,
  game_code text not null,
  game_name text not null,
  game_family text not null,
  jurisdiction_bindings jsonb not null default '[]'::jsonb,
  wager_schemas jsonb not null default '[]'::jsonb,
  outcome_strategy_references jsonb not null default '[]'::jsonb,
  math_model_references jsonb not null default '[]'::jsonb,
  paytable_references jsonb not null default '[]'::jsonb,
  settlement_policy_references jsonb not null default '[]'::jsonb,
  sales_rules jsonb not null default '{}'::jsonb,
  cancellation_correction_rules jsonb not null default '{}'::jsonb,
  replay_resettlement_policy jsonb not null default '{}'::jsonb,
  certification_pack_reference text not null,
  regulator_profile text not null,
  operator_approval_state text not null,
  lifecycle_state text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  semantic_version text not null,
  content_hash text not null,
  signature_metadata jsonb not null,
  created_at timestamptz not null default now(),
  constraint ux_game_manifests_game_version unique (game_id, semantic_version),
  constraint ux_game_manifests_content_hash unique (content_hash),
  check (jsonb_typeof(jurisdiction_bindings) = 'array'),
  check (jsonb_typeof(wager_schemas) = 'array'),
  check (jsonb_typeof(outcome_strategy_references) = 'array'),
  check (jsonb_typeof(math_model_references) = 'array'),
  check (jsonb_typeof(paytable_references) = 'array'),
  check (jsonb_typeof(settlement_policy_references) = 'array'),
  check (jsonb_typeof(sales_rules) = 'object'),
  check (jsonb_typeof(cancellation_correction_rules) = 'object'),
  check (jsonb_typeof(replay_resettlement_policy) = 'object'),
  check (jsonb_typeof(signature_metadata) = 'object'),
  check (effective_to is null or effective_to > effective_from),
  check (operator_approval_state in ('NotSubmitted', 'PendingApproval', 'Approved', 'Rejected', 'Revoked')),
  check (lifecycle_state in ('Draft', 'InternalReview', 'SimulationCertified', 'CertificationPending', 'Certified', 'GovernanceApproved', 'ProductionActive', 'Suspended', 'Retired', 'Superseded'))
);

create index idx_game_manifests_game_id_version
  on game_engine.game_manifests(game_id, semantic_version);

create index idx_game_manifests_content_hash
  on game_engine.game_manifests(content_hash);

create index idx_game_manifests_lifecycle_state
  on game_engine.game_manifests(lifecycle_state);

create table game_engine.authority_certificates (
  certificate_id uuid primary key,
  authority_id text not null,
  certificate_type text not null,
  subject_id text not null,
  subject_version text not null,
  canonical_payload_hash text not null,
  previous_certificate_id uuid references game_engine.authority_certificates(certificate_id),
  previous_certificate_hash text,
  signing_key_id text not null,
  hash_algorithm_version text not null,
  signing_algorithm_version text not null,
  issued_at timestamptz not null,
  jurisdiction_profile text not null,
  approval_state text not null,
  revocation_certificate_id uuid references game_engine.authority_certificates(certificate_id),
  supersedes_certificate_id uuid references game_engine.authority_certificates(certificate_id),
  certificate_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ux_authority_certificates_subject_hash unique (certificate_type, subject_id, subject_version, canonical_payload_hash),
  check (certificate_type in ('GovernanceApproval', 'GameManifest', 'OutcomeStrategy', 'RngProvider', 'Outcome', 'MathModel', 'MathEvaluation', 'Settlement', 'Financial', 'AuditExport')),
  check (approval_state in ('Draft', 'PendingApproval', 'Approved', 'Rejected', 'Revoked', 'Superseded')),
  check (jsonb_typeof(certificate_payload) = 'object')
);

create index idx_authority_certificates_subject_version_hash
  on game_engine.authority_certificates(subject_id, subject_version, canonical_payload_hash);

create index idx_authority_certificates_type_subject
  on game_engine.authority_certificates(certificate_type, subject_id);

create index idx_authority_certificates_previous_certificate
  on game_engine.authority_certificates(previous_certificate_id);

create or replace function game_engine.prevent_game_manifest_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.game_manifests is append-only; create a new manifest version instead';
end;
$$;

create or replace function game_engine.prevent_authority_certificate_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.authority_certificates is append-only; create a superseding certificate instead';
end;
$$;

create trigger trg_prevent_game_manifest_update
before update on game_engine.game_manifests
for each row execute function game_engine.prevent_game_manifest_mutation();

create trigger trg_prevent_game_manifest_delete
before delete on game_engine.game_manifests
for each row execute function game_engine.prevent_game_manifest_mutation();

create trigger trg_prevent_authority_certificate_update
before update on game_engine.authority_certificates
for each row execute function game_engine.prevent_authority_certificate_mutation();

create trigger trg_prevent_authority_certificate_delete
before delete on game_engine.authority_certificates
for each row execute function game_engine.prevent_authority_certificate_mutation();

comment on table game_engine.game_manifests is
  'Immutable Game Manifest v1 records. Changes create new semantic versions; historic tickets bind to the original manifest version.';

comment on table game_engine.authority_certificates is
  'Append-only authority certificate chain records for governance, manifest, outcome, math, settlement, financial, and audit evidence.';
