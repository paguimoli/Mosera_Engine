create table if not exists game_engine.outcome_runtime_rollback_watermarks (
  watermark_id uuid primary key,
  watermark_scope text not null,
  sequence_number bigint not null,
  previous_chain_hash text,
  chain_root_hash text not null,
  boot_id uuid not null,
  runtime_request_id uuid,
  evidence_hashes text[] not null,
  observed_at timestamptz not null,
  production_authority_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  constraint ux_outcome_runtime_rollback_watermark_scope_sequence unique (watermark_scope, sequence_number),
  constraint ux_outcome_runtime_rollback_watermark_chain_root unique (chain_root_hash),
  check (length(trim(watermark_scope)) > 0),
  check (sequence_number > 0),
  check (previous_chain_hash is null or previous_chain_hash like 'sha256:%'),
  check (chain_root_hash like 'sha256:%'),
  check (cardinality(evidence_hashes) > 0),
  check (production_authority_enabled = false)
);

create index if not exists idx_outcome_runtime_rollback_watermarks_scope_created
  on game_engine.outcome_runtime_rollback_watermarks(watermark_scope, created_at desc);

create index if not exists idx_outcome_runtime_rollback_watermarks_boot
  on game_engine.outcome_runtime_rollback_watermarks(boot_id);

create index if not exists idx_outcome_runtime_rollback_watermarks_request
  on game_engine.outcome_runtime_rollback_watermarks(runtime_request_id);

create or replace function game_engine.validate_outcome_runtime_rollback_watermark()
returns trigger
language plpgsql
as $$
declare
  previous_record record;
begin
  if not game_engine.validate_outcome_validation_hashes(new.evidence_hashes) then
    raise exception 'Rollback watermark evidence hashes must be sha256 hashes';
  end if;

  select sequence_number, chain_root_hash
  into previous_record
  from game_engine.outcome_runtime_rollback_watermarks
  where watermark_scope = new.watermark_scope
  order by sequence_number desc, created_at desc
  limit 1;

  if found then
    if new.sequence_number <= previous_record.sequence_number then
      raise exception 'Rollback watermark sequence regression detected for scope %', new.watermark_scope;
    end if;

    if new.previous_chain_hash is distinct from previous_record.chain_root_hash then
      raise exception 'Rollback watermark chain mismatch for scope %', new.watermark_scope;
    end if;
  elsif new.previous_chain_hash is not null then
    raise exception 'First rollback watermark for a scope cannot reference a previous chain hash';
  end if;

  return new;
end;
$$;

create trigger trg_validate_outcome_runtime_rollback_watermark
before insert on game_engine.outcome_runtime_rollback_watermarks
for each row execute function game_engine.validate_outcome_runtime_rollback_watermark();

create trigger trg_prevent_outcome_runtime_rollback_watermark_update
before update on game_engine.outcome_runtime_rollback_watermarks
for each row execute function game_engine.prevent_outcome_validation_evidence_mutation();

create trigger trg_prevent_outcome_runtime_rollback_watermark_delete
before delete on game_engine.outcome_runtime_rollback_watermarks
for each row execute function game_engine.prevent_outcome_validation_evidence_mutation();

comment on table game_engine.outcome_runtime_rollback_watermarks is
  'Append-only runtime watermark evidence for detecting PITR, rollback, nonce sequence, request, certificate, and provenance regressions. Production Outcome Authority remains disabled.';
