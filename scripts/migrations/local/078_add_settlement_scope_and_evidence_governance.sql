alter table settlement_service.settlement_requests
  add column tenant_id uuid references platform.tenants(id),
  add column brand_id uuid references platform.brands(id),
  add column game_reference text,
  add column draw_outcome_reference text,
  add column scope_hash text;

alter table settlement_service.authoritative_settlement_records
  add column tenant_id uuid references platform.tenants(id),
  add column brand_id uuid references platform.brands(id),
  add column game_reference text,
  add column draw_outcome_reference text,
  add column scope_hash text;

alter table settlement_service.financial_instructions
  add column tenant_id uuid references platform.tenants(id),
  add column brand_id uuid references platform.brands(id),
  add column scope_hash text;

alter table settlement_service.resettlement_requests
  add column tenant_id uuid references platform.tenants(id),
  add column brand_id uuid references platform.brands(id),
  add column scope_hash text;

alter table settlement_service.resettlement_records
  add column tenant_id uuid references platform.tenants(id),
  add column brand_id uuid references platform.brands(id),
  add column scope_hash text;

create index idx_settlement_requests_scope
  on settlement_service.settlement_requests(tenant_id, brand_id, ticket_id);
create index idx_authoritative_settlement_records_scope
  on settlement_service.authoritative_settlement_records(tenant_id, brand_id, ticket_id);
create index idx_financial_instructions_scope
  on settlement_service.financial_instructions(tenant_id, brand_id, settlement_id);
create index idx_resettlement_requests_scope
  on settlement_service.resettlement_requests(tenant_id, brand_id, original_settlement_id);

create or replace function settlement_service.assert_canonical_scope(
  p_tenant_id uuid,
  p_brand_id uuid,
  p_scope_hash text
) returns void
language plpgsql
as $$
declare
  v_brand_tenant_id uuid;
begin
  if p_tenant_id is null or p_brand_id is null then
    raise exception 'Canonical settlement tenant and brand scope are required.';
  end if;

  if p_scope_hash is null or p_scope_hash !~ '^sha256:[0-9a-f]{64}$' then
    raise exception 'Canonical settlement scope hash is required.';
  end if;

  select tenant_id into v_brand_tenant_id
  from platform.brands
  where id = p_brand_id;

  if v_brand_tenant_id is null or v_brand_tenant_id <> p_tenant_id then
    raise exception 'Canonical settlement brand does not belong to tenant.';
  end if;
end;
$$;

create or replace function settlement_service.validate_scoped_settlement_request()
returns trigger language plpgsql as $$
begin
  perform settlement_service.assert_canonical_scope(new.tenant_id, new.brand_id, new.scope_hash);
  if nullif(btrim(new.game_reference), '') is null
     or nullif(btrim(new.draw_outcome_reference), '') is null then
    raise exception 'Canonical settlement game and draw/outcome references are required.';
  end if;
  return new;
end;
$$;

create trigger trg_validate_scoped_settlement_request
before insert on settlement_service.settlement_requests
for each row execute function settlement_service.validate_scoped_settlement_request();

create or replace function settlement_service.validate_scoped_settlement_record()
returns trigger language plpgsql as $$
declare
  v_request settlement_service.settlement_requests%rowtype;
begin
  perform settlement_service.assert_canonical_scope(new.tenant_id, new.brand_id, new.scope_hash);
  select * into v_request
  from settlement_service.settlement_requests
  where settlement_request_id = new.settlement_request_id;

  if not found
     or row(new.tenant_id, new.brand_id, new.game_reference, new.draw_outcome_reference, new.scope_hash)
        is distinct from
        row(v_request.tenant_id, v_request.brand_id, v_request.game_reference,
            v_request.draw_outcome_reference, v_request.scope_hash) then
    raise exception 'Settlement decision scope does not match the canonical request.';
  end if;
  return new;
end;
$$;

create trigger trg_validate_scoped_settlement_record
before insert on settlement_service.authoritative_settlement_records
for each row execute function settlement_service.validate_scoped_settlement_record();

create or replace function settlement_service.validate_scoped_financial_instruction()
returns trigger language plpgsql as $$
declare
  v_record settlement_service.authoritative_settlement_records%rowtype;
begin
  perform settlement_service.assert_canonical_scope(new.tenant_id, new.brand_id, new.scope_hash);
  select * into v_record
  from settlement_service.authoritative_settlement_records
  where settlement_id = new.settlement_id;

  if not found
     or row(new.tenant_id, new.brand_id, new.scope_hash)
        is distinct from row(v_record.tenant_id, v_record.brand_id, v_record.scope_hash) then
    raise exception 'Financial instruction scope does not match the settlement decision.';
  end if;
  return new;
end;
$$;

create trigger trg_validate_scoped_financial_instruction
before insert on settlement_service.financial_instructions
for each row execute function settlement_service.validate_scoped_financial_instruction();

create or replace function settlement_service.validate_scoped_resettlement_request()
returns trigger language plpgsql as $$
declare
  v_original settlement_service.authoritative_settlement_records%rowtype;
begin
  perform settlement_service.assert_canonical_scope(new.tenant_id, new.brand_id, new.scope_hash);
  select * into v_original
  from settlement_service.authoritative_settlement_records
  where settlement_id = new.original_settlement_id;

  if not found
     or row(new.tenant_id, new.brand_id, new.scope_hash)
        is distinct from row(v_original.tenant_id, v_original.brand_id, v_original.scope_hash) then
    raise exception 'Resettlement scope must match the original settlement.';
  end if;
  return new;
end;
$$;

create trigger trg_validate_scoped_resettlement_request
before insert on settlement_service.resettlement_requests
for each row execute function settlement_service.validate_scoped_resettlement_request();

create or replace function settlement_service.validate_scoped_resettlement_record()
returns trigger language plpgsql as $$
declare
  v_request settlement_service.resettlement_requests%rowtype;
begin
  perform settlement_service.assert_canonical_scope(new.tenant_id, new.brand_id, new.scope_hash);
  select * into v_request
  from settlement_service.resettlement_requests
  where resettlement_request_id = new.resettlement_request_id;

  if not found
     or row(new.tenant_id, new.brand_id, new.scope_hash)
        is distinct from row(v_request.tenant_id, v_request.brand_id, v_request.scope_hash) then
    raise exception 'Resettlement record scope does not match the governed request.';
  end if;
  return new;
end;
$$;

create trigger trg_validate_scoped_resettlement_record
before insert on settlement_service.resettlement_records
for each row execute function settlement_service.validate_scoped_resettlement_record();

create table settlement_service.settlement_evidence_classifications (
  classification_id uuid primary key,
  target_type text not null,
  target_id uuid not null,
  classification text not null,
  reason text not null,
  evidence_source text not null,
  reviewer_reference text not null,
  promotion_eligible boolean not null,
  recovery_required boolean not null,
  correlation_reference text not null,
  evidence_hash text not null unique,
  created_at timestamptz not null default now(),
  check (target_type in ('SETTLEMENT_RECORD', 'FINANCIAL_INSTRUCTION', 'RECOVERY_ITEM')),
  check (classification in (
    'PRE_CANONICAL_DEVELOPMENT',
    'DRY_RUN_EVIDENCE',
    'SYNTHETIC_QA_EVIDENCE',
    'INCOMPLETE_FAILED_EXECUTION',
    'RECOVERABLE_PRODUCTION_SHAPED',
    'SUPERSEDED_EVIDENCE',
    'UNKNOWN_OR_INCONSISTENT'
  )),
  check (btrim(reason) <> ''),
  check (btrim(evidence_source) <> ''),
  check (btrim(reviewer_reference) <> ''),
  check (btrim(correlation_reference) <> ''),
  check (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  check (
    promotion_eligible
    or classification in (
      'PRE_CANONICAL_DEVELOPMENT',
      'DRY_RUN_EVIDENCE',
      'SYNTHETIC_QA_EVIDENCE',
      'SUPERSEDED_EVIDENCE'
    )
  )
);

create index idx_settlement_evidence_classifications_target
  on settlement_service.settlement_evidence_classifications(target_type, target_id, created_at desc);
create index idx_settlement_evidence_classifications_promotion
  on settlement_service.settlement_evidence_classifications(promotion_eligible, classification);

create view settlement_service.settlement_promotion_exclusions as
select distinct on (target_type, target_id)
  target_type,
  target_id,
  classification,
  reason,
  evidence_source,
  reviewer_reference,
  recovery_required,
  correlation_reference,
  evidence_hash,
  created_at
from settlement_service.settlement_evidence_classifications
where promotion_eligible = false
  and classification in (
    'PRE_CANONICAL_DEVELOPMENT',
    'DRY_RUN_EVIDENCE',
    'SYNTHETIC_QA_EVIDENCE',
    'SUPERSEDED_EVIDENCE'
  )
order by target_type, target_id, created_at desc, classification_id desc;

create or replace function settlement_service.prevent_settlement_evidence_classification_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'Settlement evidence classifications are append-only.';
end;
$$;

create trigger trg_prevent_settlement_evidence_classification_update
before update on settlement_service.settlement_evidence_classifications
for each row execute function settlement_service.prevent_settlement_evidence_classification_mutation();

create trigger trg_prevent_settlement_evidence_classification_delete
before delete on settlement_service.settlement_evidence_classifications
for each row execute function settlement_service.prevent_settlement_evidence_classification_mutation();

comment on table settlement_service.settlement_evidence_classifications is
  'Append-only governed classification evidence. Only explicitly proven development, dry-run, synthetic QA, or superseded evidence may be excluded from promotion evaluation.';
