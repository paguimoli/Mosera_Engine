create schema if not exists game_engine;

create table game_engine.game_modules (
  id uuid primary key,
  code text not null unique,
  display_name text not null,
  lifecycle_status text not null,
  active_version_id uuid,
  created_at timestamptz not null default now(),
  check (code <> ''),
  check (lifecycle_status in ('DRAFT', 'ACTIVE', 'DISABLED', 'RETIRED'))
);

create table game_engine.game_module_versions (
  id uuid primary key,
  game_module_id uuid not null references game_engine.game_modules(id),
  version text not null,
  sdk_version text not null,
  manifest_hash text not null,
  lifecycle_status text not null,
  created_at timestamptz not null default now(),
  unique (game_module_id, version),
  check (version <> '')
);

create table game_engine.game_definitions (
  id uuid primary key,
  code text not null unique,
  display_name text not null,
  active_version_id uuid,
  game_module_id uuid not null references game_engine.game_modules(id),
  created_at timestamptz not null default now(),
  check (code <> '')
);

create table game_engine.game_definition_versions (
  id uuid primary key,
  game_definition_id uuid not null references game_engine.game_definitions(id),
  version_number integer not null,
  definition_hash text not null,
  paytable_version text not null,
  evaluator_version text not null,
  draw_generator_version text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  unique (game_definition_id, version_number),
  check (version_number > 0),
  check (effective_to is null or effective_to > effective_from)
);

create table game_engine.draw_authorities (
  id uuid primary key,
  code text not null unique,
  display_name text not null,
  provider_type text not null,
  status text not null,
  active_version_id uuid,
  created_at timestamptz not null default now(),
  check (code <> '')
);

create table game_engine.draw_authority_versions (
  id uuid primary key,
  draw_authority_id uuid not null references game_engine.draw_authorities(id),
  version text not null,
  provider_version text not null,
  configuration_hash text not null,
  status text not null,
  created_at timestamptz not null default now(),
  unique (draw_authority_id, version)
);

create table game_engine.draw_authority_assignments (
  id uuid primary key,
  game_definition_id uuid not null references game_engine.game_definitions(id),
  draw_authority_id uuid not null references game_engine.draw_authorities(id),
  draw_authority_version_id uuid not null references game_engine.draw_authority_versions(id),
  settlement_trigger_policy text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  check (effective_to is null or effective_to > effective_from)
);

create table game_engine.draw_schedules (
  id uuid primary key,
  game_definition_id uuid not null references game_engine.game_definitions(id),
  draw_authority_assignment_id uuid not null references game_engine.draw_authority_assignments(id),
  sales_open_at timestamptz not null,
  sales_close_at timestamptz not null,
  draw_at timestamptz not null,
  status text not null,
  check (sales_close_at > sales_open_at),
  check (draw_at >= sales_close_at)
);

create table game_engine.draw_result_submissions (
  id uuid primary key,
  draw_schedule_id uuid not null references game_engine.draw_schedules(id),
  draw_authority_id uuid not null references game_engine.draw_authorities(id),
  result_hash text not null,
  result_payload_reference text not null,
  submitted_by text not null,
  submitted_at timestamptz not null,
  is_manual_submission boolean not null default false
);

create table game_engine.official_certified_draw_results (
  id uuid primary key,
  draw_schedule_id uuid not null references game_engine.draw_schedules(id),
  draw_result_submission_id uuid not null references game_engine.draw_result_submissions(id),
  certified_by text not null,
  certified_at timestamptz not null,
  game_module_version text not null,
  draw_generator_version text not null,
  prng_provider_version text not null,
  draw_authority_version text not null,
  algorithm_version text not null,
  payload_hash text not null,
  unique (draw_schedule_id)
);
