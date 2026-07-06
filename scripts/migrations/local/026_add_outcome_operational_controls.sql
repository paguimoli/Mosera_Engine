create table game_engine.outcome_operational_controls (
  control_id uuid primary key,
  control_type text not null,
  target_artifact_type text not null,
  target_artifact_id text not null,
  reason_code text not null,
  requested_by text not null,
  approved_by text,
  dual_approval_status text not null,
  production_affecting boolean not null default true,
  effective_at timestamptz not null,
  expires_at timestamptz,
  renewed_by_control_id uuid references game_engine.outcome_operational_controls(control_id),
  original_outcome_certificate_id uuid references game_engine.outcome_certificates(certificate_id),
  evidence_hash text not null,
  audit_evidence jsonb not null default '{}'::jsonb,
  signing_metadata jsonb,
  created_at timestamptz not null default now(),
  constraint ux_outcome_operational_controls_hash unique (evidence_hash),
  check (control_type in ('EMERGENCY_DISABLE', 'DRAW_CANCEL', 'OUTCOME_VOID', 'OUTCOME_SUPERSEDE', 'OUTCOME_REPLAY', 'OUTCOME_DISPUTE')),
  check (target_artifact_type in ('Draw', 'OutcomeEvent', 'OutcomeCertificate', 'OutcomeStrategy', 'RngProvider')),
  check (dual_approval_status in ('Requested', 'Approved', 'Rejected', 'Expired')),
  check (btrim(reason_code) <> ''),
  check (btrim(requested_by) <> ''),
  check (approved_by is null or btrim(approved_by) <> ''),
  check (expires_at is null or expires_at > effective_at),
  check (evidence_hash like 'sha256:%'),
  check (jsonb_typeof(audit_evidence) = 'object'),
  check (signing_metadata is null or jsonb_typeof(signing_metadata) = 'object')
);

create table game_engine.outcome_custody_events (
  custody_event_id uuid primary key,
  outcome_certificate_id uuid not null references game_engine.outcome_certificates(certificate_id),
  from_state text,
  to_state text not null,
  control_id uuid references game_engine.outcome_operational_controls(control_id),
  reason_code text not null,
  evidence_hash text not null,
  signing_metadata jsonb,
  created_at timestamptz not null default now(),
  constraint ux_outcome_custody_events_hash unique (evidence_hash),
  check (from_state is null or from_state in ('Generated', 'Sealed', 'Certified', 'Superseded', 'Voided', 'Disputed')),
  check (to_state in ('Generated', 'Sealed', 'Certified', 'Superseded', 'Voided', 'Disputed')),
  check (btrim(reason_code) <> ''),
  check (evidence_hash like 'sha256:%'),
  check (signing_metadata is null or jsonb_typeof(signing_metadata) = 'object')
);

create index idx_outcome_operational_controls_target
  on game_engine.outcome_operational_controls(target_artifact_type, target_artifact_id);

create index idx_outcome_operational_controls_type
  on game_engine.outcome_operational_controls(control_type);

create index idx_outcome_operational_controls_status
  on game_engine.outcome_operational_controls(dual_approval_status);

create index idx_outcome_operational_controls_hash
  on game_engine.outcome_operational_controls(evidence_hash);

create index idx_outcome_custody_events_certificate
  on game_engine.outcome_custody_events(outcome_certificate_id);

create index idx_outcome_custody_events_state
  on game_engine.outcome_custody_events(to_state);

create index idx_outcome_custody_events_control
  on game_engine.outcome_custody_events(control_id);

create index idx_outcome_custody_events_hash
  on game_engine.outcome_custody_events(evidence_hash);

create or replace function game_engine.outcome_control_has_financial_fields(payload jsonb)
returns boolean
language sql
immutable
as $$
  select payload::text ~* '"(ledger|ledgerEntry|ledgerTransaction|wallet|cash|cashier|payout|payment|financialEffect|moneyMovement)"[[:space:]]*:';
$$;

create or replace function game_engine.validate_outcome_operational_control()
returns trigger
language plpgsql
as $$
begin
  if game_engine.outcome_control_has_financial_fields(new.audit_evidence)
    or game_engine.outcome_control_has_financial_fields(coalesce(new.signing_metadata, '{}'::jsonb)) then
    raise exception 'Outcome operational controls cannot create or reference ledger, wallet, cashier, payout, or financial effects';
  end if;

  if new.production_affecting then
    if new.dual_approval_status <> 'Approved' then
      raise exception 'Production-affecting outcome controls require dual approval';
    end if;

    if new.approved_by is null then
      raise exception 'Production-affecting outcome controls require an approver';
    end if;

    if lower(new.requested_by) = lower(new.approved_by) then
      raise exception 'Outcome controls require different requester and approver principals';
    end if;
  end if;

  if new.control_type = 'EMERGENCY_DISABLE'
    and new.expires_at is null
    and new.renewed_by_control_id is null then
    raise exception 'Emergency disable must be time-bound or explicitly renewed';
  end if;

  if new.control_type = 'OUTCOME_SUPERSEDE'
    and new.original_outcome_certificate_id is null then
    raise exception 'Outcome supersession must reference the original outcome certificate';
  end if;

  if new.control_type in ('OUTCOME_VOID', 'OUTCOME_REPLAY')
    and new.audit_evidence = '{}'::jsonb then
    raise exception 'Void and replay controls must produce audit evidence';
  end if;

  if new.target_artifact_type = 'OutcomeCertificate'
    and not exists (
      select 1
      from game_engine.outcome_certificates
      where certificate_id::text = new.target_artifact_id
    ) then
    raise exception 'Outcome certificate control target is invalid';
  end if;

  if new.target_artifact_type = 'OutcomeEvent'
    and not exists (
      select 1
      from game_engine.outcome_events
      where outcome_id::text = new.target_artifact_id
    ) then
    raise exception 'Outcome event control target is invalid';
  end if;

  return new;
end;
$$;

create or replace function game_engine.validate_outcome_custody_event()
returns trigger
language plpgsql
as $$
declare
  control_record record;
  expected_from_state text;
begin
  select custody_state
    into expected_from_state
  from game_engine.outcome_certificates
  where certificate_id = new.outcome_certificate_id;

  if expected_from_state is null then
    raise exception 'Outcome custody event requires a valid outcome certificate';
  end if;

  if new.from_state is not null and new.from_state <> expected_from_state then
    raise exception 'Outcome custody event from_state must match the immutable certificate custody state';
  end if;

  if game_engine.outcome_control_has_financial_fields(coalesce(new.signing_metadata, '{}'::jsonb)) then
    raise exception 'Outcome custody events cannot create or reference ledger, wallet, cashier, payout, or financial effects';
  end if;

  if new.from_state is null then
    if new.to_state <> 'Generated' then
      raise exception 'Initial custody event must enter Generated state';
    end if;

    return new;
  end if;

  if not (
    (new.from_state = 'Generated' and new.to_state in ('Sealed', 'Certified', 'Voided', 'Disputed')) or
    (new.from_state = 'Sealed' and new.to_state in ('Certified', 'Voided', 'Disputed')) or
    (new.from_state = 'Certified' and new.to_state in ('Superseded', 'Voided', 'Disputed')) or
    (new.from_state = 'Disputed' and new.to_state in ('Sealed', 'Certified', 'Superseded', 'Voided'))
  ) then
    raise exception 'Outcome custody transition is not allowed';
  end if;

  if new.to_state in ('Superseded', 'Voided', 'Disputed') and new.control_id is null then
    raise exception 'Governed custody transitions require an operational control';
  end if;

  if new.control_id is not null then
    select *
      into control_record
    from game_engine.outcome_operational_controls
    where control_id = new.control_id;

    if not found then
      raise exception 'Outcome custody control reference is invalid';
    end if;

    if control_record.dual_approval_status <> 'Approved' then
      raise exception 'Outcome custody control must be approved';
    end if;

    if new.to_state = 'Superseded' and control_record.control_type <> 'OUTCOME_SUPERSEDE' then
      raise exception 'Supersession custody events require an OUTCOME_SUPERSEDE control';
    end if;

    if new.to_state = 'Voided' and control_record.control_type <> 'OUTCOME_VOID' then
      raise exception 'Voiding custody events require an OUTCOME_VOID control';
    end if;

    if new.to_state = 'Disputed' and control_record.control_type <> 'OUTCOME_DISPUTE' then
      raise exception 'Dispute custody events require an OUTCOME_DISPUTE control';
    end if;
  end if;

  return new;
end;
$$;

create or replace function game_engine.prevent_outcome_operational_control_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.outcome_operational_controls is append-only; create a new operational control instead';
end;
$$;

create or replace function game_engine.prevent_outcome_custody_event_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'game_engine.outcome_custody_events is append-only; create a new custody event instead';
end;
$$;

create trigger trg_validate_outcome_operational_control
before insert on game_engine.outcome_operational_controls
for each row execute function game_engine.validate_outcome_operational_control();

create trigger trg_prevent_outcome_operational_control_update
before update on game_engine.outcome_operational_controls
for each row execute function game_engine.prevent_outcome_operational_control_mutation();

create trigger trg_prevent_outcome_operational_control_delete
before delete on game_engine.outcome_operational_controls
for each row execute function game_engine.prevent_outcome_operational_control_mutation();

create trigger trg_validate_outcome_custody_event
before insert on game_engine.outcome_custody_events
for each row execute function game_engine.validate_outcome_custody_event();

create trigger trg_prevent_outcome_custody_event_update
before update on game_engine.outcome_custody_events
for each row execute function game_engine.prevent_outcome_custody_event_mutation();

create trigger trg_prevent_outcome_custody_event_delete
before delete on game_engine.outcome_custody_events
for each row execute function game_engine.prevent_outcome_custody_event_mutation();

comment on table game_engine.outcome_operational_controls is
  'Append-only governed controls for outcome custody, correction, supersession, replay, voiding, dispute, draw cancellation, and emergency disable. No production Outcome Authority is enabled.';

comment on table game_engine.outcome_custody_events is
  'Append-only custody transition evidence for outcome certificates. Custody events do not mutate immutable certificates and cannot create financial effects.';
