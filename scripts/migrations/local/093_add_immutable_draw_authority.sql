create table game_engine.published_draw_schedule_versions (
  schedule_version_id uuid primary key,
  schedule_id uuid not null,
  version_number integer not null check (version_number > 0),
  game_definition_id uuid not null
    references game_engine.game_definitions(id) on delete restrict,
  draw_authority_assignment_id uuid not null
    references game_engine.draw_authority_assignments(id) on delete restrict,
  schedule_kind text not null,
  schedule_configuration jsonb not null,
  time_zone_id text not null,
  schedule_hash text not null check (schedule_hash like 'sha256:%'),
  published_at timestamptz not null,
  constraint ux_published_draw_schedule_version unique (schedule_id, version_number),
  constraint ux_published_draw_schedule_hash unique (schedule_id, schedule_hash)
);

create index idx_published_draw_schedule_versions_lookup
  on game_engine.published_draw_schedule_versions(schedule_id, version_number desc);

alter table game_engine.draw_schedules
  add column schedule_version_id uuid,
  add column scheduled_execution_at timestamptz,
  add column schedule_hash text,
  add column draw_identity_hash text;

insert into game_engine.draw_schedules (
  id,
  game_definition_id,
  draw_authority_assignment_id,
  sales_open_at,
  sales_close_at,
  draw_at,
  status)
select
  missing.draw_id,
  dependency.game_definition_id,
  dependency.draw_authority_assignment_id,
  missing.generated_at - interval '1 hour',
  missing.generated_at,
  missing.generated_at,
  'Certified'
from (
  select distinct version.draw_id, version.generated_at
  from game_engine.canonical_outcome_versions version
  where not exists (
    select 1 from game_engine.draw_schedules draw where draw.id = version.draw_id
  )
) missing
cross join lateral (
  select assignment.game_definition_id, assignment.id as draw_authority_assignment_id
  from game_engine.draw_authority_assignments assignment
  order by assignment.effective_from, assignment.id
  limit 1
) dependency;

insert into game_engine.published_draw_schedule_versions (
  schedule_version_id,
  schedule_id,
  version_number,
  game_definition_id,
  draw_authority_assignment_id,
  schedule_kind,
  schedule_configuration,
  time_zone_id,
  schedule_hash,
  published_at)
select
  id,
  id,
  1,
  game_definition_id,
  draw_authority_assignment_id,
  'LEGACY_IMPORTED',
  jsonb_build_object(
    'salesOpenAt', sales_open_at,
    'salesCloseAt', sales_close_at,
    'drawAt', draw_at),
  'UTC',
  'sha256:' || encode(digest(
    id::text || '|' || game_definition_id::text || '|' ||
    draw_authority_assignment_id::text || '|' || draw_at::text,
    'sha256'), 'hex'),
  least(sales_open_at, now())
from game_engine.draw_schedules;

update game_engine.draw_schedules
set
  schedule_version_id = id,
  scheduled_execution_at = draw_at,
  schedule_hash = 'sha256:' || encode(digest(
    id::text || '|' || game_definition_id::text || '|' ||
    draw_authority_assignment_id::text || '|' || draw_at::text,
    'sha256'), 'hex'),
  draw_identity_hash = 'sha256:' || encode(digest(
    'draw-instance:v1|' || id::text || '|' || draw_at::text,
    'sha256'), 'hex');

alter table game_engine.draw_schedules
  alter column schedule_version_id set not null,
  alter column scheduled_execution_at set not null,
  alter column schedule_hash set not null,
  alter column draw_identity_hash set not null,
  add constraint fk_draw_instance_schedule_version
    foreign key (schedule_version_id)
    references game_engine.published_draw_schedule_versions(schedule_version_id)
    on delete restrict,
  add constraint ck_draw_instance_schedule_hash
    check (schedule_hash like 'sha256:%'),
  add constraint ck_draw_instance_identity_hash
    check (draw_identity_hash like 'sha256:%'),
  add constraint ux_draw_instance_schedule_execution
    unique (schedule_version_id, scheduled_execution_at),
  add constraint ux_draw_instance_identity_hash
    unique (draw_identity_hash);

create table game_engine.draw_execution_manifests (
  execution_manifest_id uuid primary key,
  draw_id uuid not null
    references game_engine.draw_schedules(id) on delete restrict,
  schedule_version_id uuid not null
    references game_engine.published_draw_schedule_versions(schedule_version_id)
    on delete restrict,
  game_definition_version_id uuid not null
    references game_engine.game_definition_versions(id) on delete restrict,
  draw_authority_version_id uuid not null
    references game_engine.draw_authority_versions(id) on delete restrict,
  engine_name text not null,
  engine_version text not null,
  outcome_provider_id text not null,
  outcome_provider_version text not null,
  evaluator_version text not null,
  paytable_version text not null,
  scheduled_execution_at timestamptz not null,
  schedule_hash text not null check (schedule_hash like 'sha256:%'),
  draw_identity_hash text not null check (draw_identity_hash like 'sha256:%'),
  canonical_manifest_hash text not null check (canonical_manifest_hash like 'sha256:%'),
  created_at timestamptz not null,
  constraint ux_draw_execution_manifest_draw unique (draw_id),
  constraint ux_draw_execution_manifest_hash unique (canonical_manifest_hash)
);

create index idx_draw_execution_manifests_schedule
  on game_engine.draw_execution_manifests(schedule_version_id, scheduled_execution_at);

insert into game_engine.draw_execution_manifests (
  execution_manifest_id,
  draw_id,
  schedule_version_id,
  game_definition_version_id,
  draw_authority_version_id,
  engine_name,
  engine_version,
  outcome_provider_id,
  outcome_provider_version,
  evaluator_version,
  paytable_version,
  scheduled_execution_at,
  schedule_hash,
  draw_identity_hash,
  canonical_manifest_hash,
  created_at)
select
  draw.id,
  draw.id,
  draw.schedule_version_id,
  definition_version.id,
  assignment.draw_authority_version_id,
  module.code,
  module_version.version,
  authority.code,
  authority_version.provider_version,
  definition_version.evaluator_version,
  definition_version.paytable_version,
  draw.scheduled_execution_at,
  draw.schedule_hash,
  draw.draw_identity_hash,
  'sha256:' || encode(digest(
    'execution-manifest:v1|' || draw.id::text || '|' ||
    draw.schedule_version_id::text || '|' || definition_version.id::text || '|' ||
    assignment.draw_authority_version_id::text || '|' || draw.draw_identity_hash,
    'sha256'), 'hex'),
  least(draw.sales_open_at, now())
from game_engine.draw_schedules draw
join game_engine.game_definitions definition
  on definition.id = draw.game_definition_id
join game_engine.game_modules module
  on module.id = definition.game_module_id
join game_engine.game_module_versions module_version
  on module_version.id = module.active_version_id
join game_engine.game_definition_versions definition_version
  on definition_version.id = definition.active_version_id
join game_engine.draw_authority_assignments assignment
  on assignment.id = draw.draw_authority_assignment_id
join game_engine.draw_authority_versions authority_version
  on authority_version.id = assignment.draw_authority_version_id
join game_engine.draw_authorities authority
  on authority.id = assignment.draw_authority_id;

alter table game_engine.canonical_outcome_versions
  add column execution_manifest_id uuid,
  add column execution_manifest_hash text;

alter table game_engine.canonical_outcome_versions disable trigger user;

update game_engine.canonical_outcome_versions version
set
  execution_manifest_id = manifest.execution_manifest_id,
  execution_manifest_hash = manifest.canonical_manifest_hash
from game_engine.draw_execution_manifests manifest
where manifest.draw_id = version.draw_id;

alter table game_engine.canonical_outcome_versions enable trigger user;

alter table game_engine.canonical_outcome_versions
  alter column execution_manifest_id set not null,
  alter column execution_manifest_hash set not null,
  add constraint fk_canonical_outcome_execution_manifest
    foreign key (execution_manifest_id)
    references game_engine.draw_execution_manifests(execution_manifest_id)
    on delete restrict,
  add constraint ck_canonical_outcome_execution_manifest_hash
    check (execution_manifest_hash like 'sha256:%');

create or replace function game_engine.prevent_immutable_draw_authority_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is immutable; % is not allowed.', tg_table_name, tg_op;
end;
$$;

create or replace function game_engine.validate_draw_instance_lifecycle_transition()
returns trigger
language plpgsql
as $$
declare
  old_rank integer;
  new_rank integer;
begin
  if row(
    new.id, new.game_definition_id, new.draw_authority_assignment_id,
    new.sales_open_at, new.sales_close_at, new.draw_at,
    new.schedule_version_id, new.scheduled_execution_at,
    new.schedule_hash, new.draw_identity_hash
  ) is distinct from row(
    old.id, old.game_definition_id, old.draw_authority_assignment_id,
    old.sales_open_at, old.sales_close_at, old.draw_at,
    old.schedule_version_id, old.scheduled_execution_at,
    old.schedule_hash, old.draw_identity_hash
  ) then
    raise exception 'Draw instance identity and execution lineage are immutable.';
  end if;

  if new.status = old.status then
    return new;
  end if;

  if old.status in ('Cancelled', 'Failed', 'Voided') then
    raise exception 'Terminal draw lifecycle state % cannot transition.', old.status;
  end if;

  old_rank := array_position(array[
    'Scheduled', 'SalesOpen', 'SalesClosed', 'AwaitingResult',
    'ResultSubmitted', 'Certified', 'EvaluationPending', 'EvaluationQueued',
    'EvaluationInProgress', 'EvaluationCompleted', 'SettlementReady'
  ], old.status);
  new_rank := array_position(array[
    'Scheduled', 'SalesOpen', 'SalesClosed', 'AwaitingResult',
    'ResultSubmitted', 'Certified', 'EvaluationPending', 'EvaluationQueued',
    'EvaluationInProgress', 'EvaluationCompleted', 'SettlementReady'
  ], new.status);

  if new.status in ('Cancelled', 'Failed', 'Voided', 'ManualReviewRequired') then
    return new;
  end if;
  if old.status = 'ManualReviewRequired'
     and new.status not in ('AwaitingResult', 'ResultSubmitted', 'Cancelled', 'Failed', 'Voided') then
    raise exception 'Invalid draw lifecycle transition from % to %.', old.status, new.status;
  end if;
  if old.status <> 'ManualReviewRequired'
     and (old_rank is null or new_rank is null or new_rank < old_rank) then
    raise exception 'Invalid draw lifecycle transition from % to %.', old.status, new.status;
  end if;
  return new;
end;
$$;

create trigger trg_prevent_published_draw_schedule_version_update
before update on game_engine.published_draw_schedule_versions
for each row execute function game_engine.prevent_immutable_draw_authority_mutation();

create trigger trg_prevent_published_draw_schedule_version_delete
before delete on game_engine.published_draw_schedule_versions
for each row execute function game_engine.prevent_immutable_draw_authority_mutation();

create trigger trg_prevent_draw_execution_manifest_update
before update on game_engine.draw_execution_manifests
for each row execute function game_engine.prevent_immutable_draw_authority_mutation();

create trigger trg_prevent_draw_execution_manifest_delete
before delete on game_engine.draw_execution_manifests
for each row execute function game_engine.prevent_immutable_draw_authority_mutation();

create trigger trg_validate_draw_instance_update
before update on game_engine.draw_schedules
for each row execute function game_engine.validate_draw_instance_lifecycle_transition();

create trigger trg_prevent_draw_instance_delete
before delete on game_engine.draw_schedules
for each row execute function game_engine.prevent_immutable_draw_authority_mutation();

comment on table game_engine.published_draw_schedule_versions is
  'Append-only published schedule versions. A schedule change always creates a new immutable version.';
comment on table game_engine.draw_schedules is
  'Canonical Draw Instance store retained under its established table name for API and ticket compatibility.';
comment on table game_engine.draw_execution_manifests is
  'One immutable execution snapshot per Draw Instance; authoritative for all engine/provider/evaluator/paytable versions.';
