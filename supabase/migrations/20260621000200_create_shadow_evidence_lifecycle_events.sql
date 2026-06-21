create table if not exists public.shadow_evidence_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  evidence_type text not null,
  evidence_id uuid not null,
  previous_status text null,
  new_status text not null,
  reason_code text not null,
  reason_note text null,
  actor_user_id uuid null,
  correlation_id text null,
  created_at timestamptz not null default now(),
  constraint shadow_evidence_lifecycle_events_domain_check
    check (domain in ('SETTLEMENT', 'LEDGER', 'CREDIT')),
  constraint shadow_evidence_lifecycle_events_evidence_type_check
    check (evidence_type in ('MISMATCH', 'FAILURE')),
  constraint shadow_evidence_lifecycle_events_previous_status_check
    check (
      previous_status is null or previous_status in (
        'ACTIVE',
        'EXCLUDED_FROM_PROMOTION',
        'ARCHIVED',
        'REVIEW_REQUIRED'
      )
    ),
  constraint shadow_evidence_lifecycle_events_new_status_check
    check (new_status in (
      'ACTIVE',
      'EXCLUDED_FROM_PROMOTION',
      'ARCHIVED',
      'REVIEW_REQUIRED'
    )),
  constraint shadow_evidence_lifecycle_events_reason_code_check
    check (reason_code in (
      'QA_INTENTIONAL',
      'QA_FAILURE_TEST',
      'LOAD_TEST',
      'BACKFILL_TEST',
      'OPERATOR_EXCLUDED',
      'EXPIRED_TEST_EVIDENCE',
      'UNEXPLAINED'
    ))
);

create index if not exists shadow_evidence_lifecycle_events_domain_idx
  on public.shadow_evidence_lifecycle_events(domain);

create index if not exists shadow_evidence_lifecycle_events_evidence_idx
  on public.shadow_evidence_lifecycle_events(domain, evidence_type, evidence_id);

create index if not exists shadow_evidence_lifecycle_events_status_idx
  on public.shadow_evidence_lifecycle_events(new_status);

create index if not exists shadow_evidence_lifecycle_events_reason_code_idx
  on public.shadow_evidence_lifecycle_events(reason_code);

create index if not exists shadow_evidence_lifecycle_events_correlation_id_idx
  on public.shadow_evidence_lifecycle_events(correlation_id);

create index if not exists shadow_evidence_lifecycle_events_created_at_idx
  on public.shadow_evidence_lifecycle_events(created_at);

create or replace function public.prevent_shadow_evidence_lifecycle_event_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Shadow evidence lifecycle events are immutable.';
end;
$$;

drop trigger if exists prevent_shadow_evidence_lifecycle_event_update
  on public.shadow_evidence_lifecycle_events;

create trigger prevent_shadow_evidence_lifecycle_event_update
before update on public.shadow_evidence_lifecycle_events
for each row
execute function public.prevent_shadow_evidence_lifecycle_event_update();

create or replace function public.prevent_shadow_evidence_lifecycle_event_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Shadow evidence lifecycle events cannot be deleted.';
end;
$$;

drop trigger if exists prevent_shadow_evidence_lifecycle_event_delete
  on public.shadow_evidence_lifecycle_events;

create trigger prevent_shadow_evidence_lifecycle_event_delete
before delete on public.shadow_evidence_lifecycle_events
for each row
execute function public.prevent_shadow_evidence_lifecycle_event_delete();

alter table public.shadow_evidence_lifecycle_events enable row level security;
