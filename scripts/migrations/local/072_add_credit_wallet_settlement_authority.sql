alter table credit_wallet_service.wallet_operation_requests
  drop constraint if exists wallet_operation_settlement_provenance_check,
  drop constraint if exists wallet_operation_reversal_original_check;
alter table credit_wallet_service.wallet_operation_requests
  add column if not exists settlement_instruction_hash text,
  add column if not exists settlement_version text,
  add column if not exists settlement_hash text,
  add column if not exists ledger_instruction_id uuid,
  add column if not exists ledger_posting_required boolean,
  add column if not exists corrects_operation_id uuid
    references credit_wallet_service.wallet_operation_requests(operation_id);

alter table credit_wallet_service.wallet_operation_requests
  add constraint wallet_operation_settlement_provenance_check check (
    operation_type not in ('SETTLE', 'REVERSE') or (
      authority = 'settlement-service'
      and source_service = 'settlement-service'
      and settlement_instruction_hash ~ '^sha256:[0-9a-f]{64}$'
      and btrim(settlement_version) <> ''
      and settlement_hash ~ '^sha256:[0-9a-f]{64}$'
      and ledger_instruction_id is not null
      and ledger_posting_required is not null
    )
  ) not valid,
  add constraint wallet_operation_reversal_original_check check (
    operation_type <> 'REVERSE' or (original_operation_id is not null and btrim(reason_code) <> '')
  );

create unique index if not exists ux_wallet_operation_reversal_original
  on credit_wallet_service.wallet_operation_requests(original_operation_id)
  where operation_type = 'REVERSE';
create unique index if not exists ux_wallet_operation_correction_reversal
  on credit_wallet_service.wallet_operation_requests(corrects_operation_id)
  where operation_type = 'SETTLE' and corrects_operation_id is not null;
create index if not exists idx_wallet_operation_settlement_trace
  on credit_wallet_service.wallet_operation_requests(
    settlement_id, settlement_instruction_id, ledger_instruction_id);

alter table public.credit_settlement_applications
  add column if not exists settlement_version text,
  add column if not exists settlement_hash text,
  add column if not exists settlement_authority text,
  add column if not exists authenticated_service text,
  add column if not exists authentication_result text,
  add column if not exists ledger_posting_required boolean,
  add column if not exists ledger_instruction_id uuid,
  add column if not exists ledger_posting_request_id uuid
    references ledger_service.ledger_posting_requests(id),
  add column if not exists ledger_journal_id uuid
    references ledger_service.ledger_transactions(id),
  add column if not exists ledger_entry_id uuid
    references public.financial_ledger_entries(id),
  add column if not exists ledger_entry_hash text,
  add column if not exists original_application_id uuid
    references public.credit_settlement_applications(id),
  add column if not exists reversal_of_operation_id uuid
    references credit_wallet_service.wallet_operation_requests(operation_id),
  add column if not exists correction_of_operation_id uuid
    references credit_wallet_service.wallet_operation_requests(operation_id);

alter table public.credit_settlement_applications
  drop constraint if exists credit_settlement_applications_operation_type_check;
alter table public.credit_settlement_applications
  drop constraint if exists credit_settlement_canonical_provenance_check,
  drop constraint if exists credit_settlement_reversal_link_check;
alter table public.credit_settlement_applications
  add constraint credit_settlement_applications_operation_type_check check (
    operation_type in (
      'PARTIAL_SETTLEMENT', 'FULL_SETTLEMENT',
      'PARTIAL_CAPTURE', 'FULL_CAPTURE',
      'PARTIAL_CORRECTION', 'FULL_CORRECTION', 'REVERSAL'
    )
  ) not valid,
  add constraint credit_settlement_canonical_provenance_check check (
    operation_id is null or (
      settlement_version is not null
      and settlement_hash ~ '^sha256:[0-9a-f]{64}$'
      and settlement_authority = 'settlement-service'
      and authenticated_service = 'settlement-service'
      and authentication_result = 'AUTHENTICATED'
      and ledger_posting_required is not null
      and ledger_instruction_id is not null
      and (not ledger_posting_required or (
        ledger_posting_request_id is not null
        and ledger_journal_id is not null
        and ledger_entry_id is not null
        and ledger_entry_hash ~ '^sha256:[0-9a-f]{64}$'
      ))
    )
  ) not valid,
  add constraint credit_settlement_reversal_link_check check (
    (operation_type = 'REVERSAL' and original_application_id is not null
      and reversal_of_operation_id is not null and correction_of_operation_id is null)
    or
    (operation_type in ('PARTIAL_CORRECTION', 'FULL_CORRECTION')
      and original_application_id is not null and correction_of_operation_id is not null
      and reversal_of_operation_id is null)
    or
    (operation_type not in ('REVERSAL', 'PARTIAL_CORRECTION', 'FULL_CORRECTION')
      and original_application_id is null and reversal_of_operation_id is null
      and correction_of_operation_id is null)
  );

create unique index if not exists ux_credit_settlement_reversal_application
  on public.credit_settlement_applications(original_application_id)
  where operation_type = 'REVERSAL';
create unique index if not exists ux_credit_settlement_correction_reversal
  on public.credit_settlement_applications(correction_of_operation_id)
  where operation_type in ('PARTIAL_CORRECTION', 'FULL_CORRECTION');
create index if not exists idx_credit_settlement_ledger_trace
  on public.credit_settlement_applications(
    ledger_instruction_id, ledger_posting_request_id, ledger_journal_id, ledger_entry_id);
create index if not exists idx_credit_settlement_chain_trace
  on public.credit_settlement_applications(
    original_application_id, reversal_of_operation_id, correction_of_operation_id);

create table if not exists credit_wallet_service.settlement_instruction_authentication_evidence (
  evidence_id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique
    references credit_wallet_service.wallet_operation_requests(operation_id),
  settlement_id uuid not null,
  settlement_instruction_id uuid not null,
  settlement_instruction_hash text not null check (
    settlement_instruction_hash ~ '^sha256:[0-9a-f]{64}$'),
  settlement_hash text not null check (settlement_hash ~ '^sha256:[0-9a-f]{64}$'),
  originating_authority text not null,
  authenticated_service text not null,
  authentication_result text not null check (authentication_result = 'AUTHENTICATED'),
  ledger_instruction_id uuid not null,
  ledger_posting_required boolean not null,
  ledger_posting_request_id uuid references ledger_service.ledger_posting_requests(id),
  ledger_journal_id uuid references ledger_service.ledger_transactions(id),
  ledger_entry_id uuid references public.financial_ledger_entries(id),
  canonical_evidence_hash text not null unique check (
    canonical_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  check (not ledger_posting_required or (
    ledger_posting_request_id is not null
    and ledger_journal_id is not null
    and ledger_entry_id is not null
  ))
);
create index if not exists idx_settlement_auth_evidence_instruction
  on credit_wallet_service.settlement_instruction_authentication_evidence(
    settlement_id, settlement_instruction_id, ledger_instruction_id);
drop trigger if exists settlement_instruction_auth_evidence_update_guard
  on credit_wallet_service.settlement_instruction_authentication_evidence;
create trigger settlement_instruction_auth_evidence_update_guard before update
  on credit_wallet_service.settlement_instruction_authentication_evidence
  for each row execute function credit_wallet_service.prevent_evidence_mutation();
drop trigger if exists settlement_instruction_auth_evidence_delete_guard
  on credit_wallet_service.settlement_instruction_authentication_evidence;
create trigger settlement_instruction_auth_evidence_delete_guard before delete
  on credit_wallet_service.settlement_instruction_authentication_evidence
  for each row execute function credit_wallet_service.prevent_evidence_mutation();

create or replace function credit_wallet_service.resolve_settlement_provenance(
  p_operation_id uuid, p_settlement_id text, p_instruction_id text,
  p_instruction_sequence bigint, p_instruction_hash text,
  p_settlement_version text, p_settlement_hash text,
  p_ledger_instruction_id uuid, p_ledger_required boolean,
  p_expected_operation text, p_amount bigint, p_balance_impact bigint,
  p_authority text, p_source_service text
) returns jsonb language plpgsql as $$
declare
  v_settlement settlement_service.authoritative_settlement_records%rowtype;
  v_instruction settlement_service.financial_instructions%rowtype;
  v_ledger_instruction settlement_service.financial_instructions%rowtype;
  v_posting ledger_service.ledger_posting_requests%rowtype;
  v_expected_capture bigint;
  v_expected_balance bigint;
  v_evidence_hash text;
begin
  if p_authority <> 'settlement-service' or p_source_service <> 'settlement-service' then
    raise exception 'Settlement authority or authenticated service identity is invalid.';
  end if;

  select * into v_settlement
  from settlement_service.authoritative_settlement_records
  where settlement_id = p_settlement_id::uuid;
  if not found then raise exception 'Authoritative Settlement reference is missing.'; end if;
  if v_settlement.canonical_settlement_hash <> p_settlement_hash
     or v_settlement.policy_version <> p_settlement_version then
    raise exception 'Authoritative Settlement version or hash mismatch.';
  end if;

  select * into v_instruction
  from settlement_service.financial_instructions
  where instruction_id = p_instruction_id::uuid;
  if not found then raise exception 'Settlement instruction reference is missing.'; end if;
  if v_instruction.settlement_id <> v_settlement.settlement_id
     or v_instruction.instruction_sequence <> p_instruction_sequence
     or v_instruction.canonical_payload_hash <> p_instruction_hash
     or v_instruction.target_service <> 'credit-wallet-service'
     or v_instruction.instruction_status not in ('Ready', 'Skipped') then
    raise exception 'Settlement instruction provenance is inconsistent.';
  end if;
  if p_expected_operation = 'SETTLE'
     and v_instruction.instruction_type not in ('CREDIT_APPLY', 'CREDIT_REFUND') then
    raise exception 'Settlement instruction is not a supported Credit capture/correction.';
  end if;
  if p_expected_operation = 'REVERSE'
     and v_instruction.instruction_type <> 'CREDIT_REFUND' then
    raise exception 'Wallet reversal requires an authoritative CREDIT_REFUND instruction.';
  end if;

  if p_expected_operation = 'SETTLE' then
    v_expected_capture := nullif(v_instruction.provenance->>'captureAmountMinor', '')::bigint;
    v_expected_balance := nullif(v_instruction.provenance->>'balanceImpactMinor', '')::bigint;
    if v_expected_capture is null or v_expected_balance is null
       or v_expected_capture <> p_amount or v_expected_balance <> p_balance_impact then
      raise exception 'Settlement instruction financial payload does not match authenticated provenance.';
    end if;
  end if;

  select * into v_ledger_instruction
  from settlement_service.financial_instructions
  where instruction_id = p_ledger_instruction_id
    and settlement_id = v_settlement.settlement_id
    and target_service = 'ledger-service'
    and instruction_sequence < v_instruction.instruction_sequence;
  if not found then raise exception 'Preceding Ledger instruction reference is missing.'; end if;

  if p_ledger_required then
    if v_ledger_instruction.instruction_type = 'LEDGER_NOOP' then
      raise exception 'Ledger posting was required but the referenced instruction is a no-op.';
    end if;
    select * into v_posting
    from ledger_service.ledger_posting_requests
    where instruction_id = p_ledger_instruction_id::text
      and originating_authority = 'settlement-service'
      and settlement_record_id = v_settlement.settlement_id
      and request_status = 'COMPLETED';
    if not found or v_posting.journal_transaction_id is null
       or v_posting.ledger_entry_id is null or v_posting.ledger_entry_hash is null then
      raise exception 'Required Ledger instruction has not completed successfully.';
    end if;
  elsif v_ledger_instruction.instruction_type <> 'LEDGER_NOOP' then
    raise exception 'No-Ledger settlement policy requires an explicit LEDGER_NOOP instruction.';
  end if;

  v_evidence_hash := 'sha256:' || encode(digest(concat_ws('|',
    p_operation_id::text, v_settlement.settlement_id::text,
    v_instruction.instruction_id::text, v_instruction.canonical_payload_hash,
    p_ledger_instruction_id::text, p_ledger_required::text,
    coalesce(v_posting.id::text, 'NO_POSTING')), 'sha256'), 'hex');

  insert into credit_wallet_service.settlement_instruction_authentication_evidence(
    operation_id, settlement_id, settlement_instruction_id,
    settlement_instruction_hash, settlement_hash, originating_authority,
    authenticated_service, authentication_result, ledger_instruction_id,
    ledger_posting_required, ledger_posting_request_id, ledger_journal_id,
    ledger_entry_id, canonical_evidence_hash)
  values (p_operation_id, v_settlement.settlement_id, v_instruction.instruction_id,
    v_instruction.canonical_payload_hash, v_settlement.canonical_settlement_hash,
    p_authority, p_source_service, 'AUTHENTICATED', p_ledger_instruction_id,
    p_ledger_required, v_posting.id, v_posting.journal_transaction_id,
    v_posting.ledger_entry_id, v_evidence_hash);

  return jsonb_build_object(
    'ledgerPostingRequestId', v_posting.id,
    'ledgerJournalId', v_posting.journal_transaction_id,
    'ledgerEntryId', v_posting.ledger_entry_id,
    'ledgerEntryHash', v_posting.ledger_entry_hash,
    'authenticationEvidenceHash', v_evidence_hash);
end;
$$;

create or replace function credit_wallet_service.apply_authoritative_wallet_settlement(
  p_operation_id uuid, p_reservation_id uuid, p_wallet_id uuid, p_tenant_id uuid,
  p_brand_id uuid, p_player_id uuid, p_instrument text, p_ticket_id text,
  p_settlement_id text, p_instruction_id text, p_instruction_sequence bigint,
  p_instruction_hash text, p_settlement_version text, p_settlement_hash text,
  p_settlement_outcome text, p_ledger_instruction_id uuid, p_ledger_required boolean,
  p_capture_amount bigint, p_balance_impact bigint, p_currency text,
  p_authority text, p_source_service text, p_corrects_operation_id uuid,
  p_idempotency_key text, p_correlation_id text, p_metadata jsonb
) returns jsonb language plpgsql as $$
declare
  v_wallet public.financial_wallets%rowtype;
  v_reservation public.credit_reservations%rowtype;
  v_existing public.credit_settlement_applications%rowtype;
  v_original public.credit_settlement_applications%rowtype;
  v_application public.credit_settlement_applications%rowtype;
  v_provenance jsonb; v_remaining bigint; v_status text; v_operation text;
  v_balance_before bigint; v_balance_after bigint;
begin
  v_wallet := credit_wallet_service.assert_wallet_scope(
    p_wallet_id, p_tenant_id, p_brand_id, p_player_id, p_instrument, p_currency);
  if v_wallet.status = 'CLOSED' then raise exception 'Closed wallet cannot apply settlement.'; end if;

  select * into v_existing from public.credit_settlement_applications
  where source_authority = p_authority and settlement_id = p_settlement_id
    and settlement_instruction_id = p_instruction_id
    and settlement_instruction_sequence = p_instruction_sequence
    and reservation_id = p_reservation_id
    and operation_type in ('PARTIAL_CAPTURE', 'FULL_CAPTURE', 'PARTIAL_CORRECTION', 'FULL_CORRECTION');
  if found then
    if v_existing.settlement_instruction_hash <> p_instruction_hash then
      raise exception 'Authoritative settlement instruction conflicts with committed application.';
    end if;
    return to_jsonb(v_existing);
  end if;

  select * into v_reservation from public.credit_reservations
  where id = p_reservation_id for update;
  if not found then raise exception 'Reservation was not found.'; end if;
  if row(v_reservation.wallet_id, v_reservation.tenant_id, v_reservation.brand_id,
         v_reservation.player_id, v_reservation.instrument_code,
         v_reservation.currency, v_reservation.ticket_id)
     is distinct from row(p_wallet_id, p_tenant_id, p_brand_id, p_player_id,
         p_instrument, p_currency, p_ticket_id) then
    raise exception 'Settlement scope does not match reservation.';
  end if;
  if v_reservation.status not in ('RESERVED', 'PARTIALLY_RELEASED', 'PARTIALLY_CAPTURED') then
    raise exception 'Terminal reservation cannot be settled.';
  end if;
  if p_capture_amount <= 0 or p_capture_amount > v_reservation.remaining_exposure then
    raise exception 'Settlement capture amount exceeds remaining exposure.';
  end if;

  if p_corrects_operation_id is not null then
    select original.* into v_original
    from credit_wallet_service.wallet_operation_requests reversal
    join public.credit_settlement_applications original
      on original.operation_id = reversal.original_operation_id
    join credit_wallet_service.wallet_operation_terminal_results terminal
      on terminal.operation_id = reversal.operation_id and terminal.terminal_status = 'COMMITTED'
    where reversal.operation_id = p_corrects_operation_id
      and reversal.operation_type = 'REVERSE'
      and original.reservation_id = p_reservation_id;
    if not found then raise exception 'Correction requires a completed reversal of the original wallet application.'; end if;
  end if;

  v_provenance := credit_wallet_service.resolve_settlement_provenance(
    p_operation_id, p_settlement_id, p_instruction_id, p_instruction_sequence,
    p_instruction_hash, p_settlement_version, p_settlement_hash,
    p_ledger_instruction_id, p_ledger_required, 'SETTLE',
    p_capture_amount, p_balance_impact, p_authority, p_source_service);

  v_remaining := v_reservation.remaining_exposure - p_capture_amount;
  v_status := case when v_remaining = 0 then 'CAPTURED' else 'PARTIALLY_CAPTURED' end;
  v_operation := case
    when p_corrects_operation_id is not null and v_remaining = 0 then 'FULL_CORRECTION'
    when p_corrects_operation_id is not null then 'PARTIAL_CORRECTION'
    when v_remaining = 0 then 'FULL_CAPTURE' else 'PARTIAL_CAPTURE' end;
  v_balance_before := coalesce(v_wallet.balance, 0)::bigint;
  v_balance_after := v_balance_before + p_balance_impact;
  update public.financial_wallets set balance = v_balance_after where id = p_wallet_id;

  insert into public.credit_settlement_applications(
    reservation_id, player_id, ticket_id, settlement_id, release_amount,
    balance_impact, balance_before, balance_after, currency, operation_type,
    idempotency_key, correlation_id, metadata, operation_id, source_authority,
    settlement_instruction_id, settlement_instruction_sequence,
    settlement_instruction_hash, wallet_id, instrument_code,
    settlement_version, settlement_hash, settlement_authority,
    authenticated_service, authentication_result, ledger_posting_required,
    ledger_instruction_id, ledger_posting_request_id, ledger_journal_id,
    ledger_entry_id, ledger_entry_hash, original_application_id,
    correction_of_operation_id)
  values (p_reservation_id, p_player_id, p_ticket_id, p_settlement_id,
    p_capture_amount, p_balance_impact, v_balance_before, v_balance_after,
    p_currency, v_operation, p_idempotency_key, p_correlation_id,
    coalesce(p_metadata, '{}'::jsonb), p_operation_id, p_authority,
    p_instruction_id, p_instruction_sequence, p_instruction_hash,
    p_wallet_id, p_instrument, p_settlement_version, p_settlement_hash,
    p_authority, p_source_service, 'AUTHENTICATED', p_ledger_required,
    p_ledger_instruction_id, (v_provenance->>'ledgerPostingRequestId')::uuid,
    (v_provenance->>'ledgerJournalId')::uuid,
    (v_provenance->>'ledgerEntryId')::uuid, v_provenance->>'ledgerEntryHash',
    v_original.id, p_corrects_operation_id)
  returning * into v_application;

  perform set_config('credit_wallet_service.projection_mutation', 'approved', true);
  update public.credit_reservations
  set captured_amount = captured_amount + p_capture_amount,
      settled_amount = settled_amount + p_capture_amount,
      remaining_exposure = v_remaining, status = v_status,
      settled_at = case when v_remaining = 0 then now() else settled_at end,
      completed_at = case when v_remaining = 0 then now() else completed_at end
  where id = p_reservation_id;
  insert into public.outbox_events(event_type, aggregate_type, aggregate_id, payload, status, correlation_id)
  values ('wallet.settlement.applied', 'credit_settlement_application', v_application.id::text,
    jsonb_build_object('operationId', p_operation_id, 'settlementId', p_settlement_id,
      'instructionId', p_instruction_id, 'ledgerInstructionId', p_ledger_instruction_id,
      'reservationId', p_reservation_id, 'operationType', v_operation),
    'PENDING', p_correlation_id);
  return to_jsonb(v_application) || jsonb_build_object(
    'reservationStatus', v_status, 'remainingExposure', v_remaining,
    'authenticationEvidenceHash', v_provenance->>'authenticationEvidenceHash');
end;
$$;

create or replace function credit_wallet_service.reverse_authoritative_wallet_settlement(
  p_operation_id uuid, p_original_operation_id uuid, p_reservation_id uuid,
  p_wallet_id uuid, p_tenant_id uuid, p_brand_id uuid, p_player_id uuid,
  p_instrument text, p_ticket_id text, p_settlement_id text,
  p_instruction_id text, p_instruction_sequence bigint, p_instruction_hash text,
  p_settlement_version text, p_settlement_hash text, p_settlement_outcome text,
  p_ledger_instruction_id uuid, p_ledger_required boolean,
  p_reversal_amount bigint, p_balance_impact bigint, p_currency text,
  p_authority text, p_source_service text, p_reason text,
  p_idempotency_key text, p_correlation_id text, p_metadata jsonb
) returns jsonb language plpgsql as $$
declare
  v_wallet public.financial_wallets%rowtype;
  v_reservation public.credit_reservations%rowtype;
  v_original public.credit_settlement_applications%rowtype;
  v_application public.credit_settlement_applications%rowtype;
  v_provenance jsonb; v_status text; v_balance_before bigint; v_balance_after bigint;
begin
  v_wallet := credit_wallet_service.assert_wallet_scope(
    p_wallet_id, p_tenant_id, p_brand_id, p_player_id, p_instrument, p_currency);
  select * into v_reservation from public.credit_reservations
  where id = p_reservation_id for update;
  if not found then raise exception 'Reservation was not found.'; end if;
  if row(v_reservation.wallet_id, v_reservation.tenant_id, v_reservation.brand_id,
         v_reservation.player_id, v_reservation.instrument_code,
         v_reservation.currency, v_reservation.ticket_id)
     is distinct from row(p_wallet_id, p_tenant_id, p_brand_id, p_player_id,
         p_instrument, p_currency, p_ticket_id) then
    raise exception 'Reversal scope does not match reservation.';
  end if;
  select application.* into v_original
  from public.credit_settlement_applications application
  join credit_wallet_service.wallet_operation_terminal_results terminal
    on terminal.operation_id = application.operation_id and terminal.terminal_status = 'COMMITTED'
  where application.operation_id = p_original_operation_id
    and application.reservation_id = p_reservation_id
    and application.operation_type in ('PARTIAL_CAPTURE', 'FULL_CAPTURE',
      'PARTIAL_CORRECTION', 'FULL_CORRECTION');
  if not found then raise exception 'Original committed wallet settlement application was not found.'; end if;
  if p_reversal_amount <> v_original.release_amount
     or p_balance_impact <> -v_original.balance_impact then
    raise exception 'Reversal must exactly oppose the original wallet application.';
  end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'Reversal reason is required.'; end if;
  if v_reservation.captured_amount < p_reversal_amount then
    raise exception 'Reservation captured amount is inconsistent with requested reversal.';
  end if;

  v_provenance := credit_wallet_service.resolve_settlement_provenance(
    p_operation_id, p_settlement_id, p_instruction_id, p_instruction_sequence,
    p_instruction_hash, p_settlement_version, p_settlement_hash,
    p_ledger_instruction_id, p_ledger_required, 'REVERSE',
    p_reversal_amount, p_balance_impact, p_authority, p_source_service);
  v_balance_before := coalesce(v_wallet.balance, 0)::bigint;
  v_balance_after := v_balance_before + p_balance_impact;
  update public.financial_wallets set balance = v_balance_after where id = p_wallet_id;

  v_status := case
    when v_reservation.captured_amount - p_reversal_amount > 0 then 'PARTIALLY_CAPTURED'
    when v_reservation.released_amount > 0 then 'PARTIALLY_RELEASED'
    else 'RESERVED' end;
  insert into public.credit_settlement_applications(
    reservation_id, player_id, ticket_id, settlement_id, release_amount,
    balance_impact, balance_before, balance_after, currency, operation_type,
    idempotency_key, correlation_id, metadata, operation_id, source_authority,
    settlement_instruction_id, settlement_instruction_sequence,
    settlement_instruction_hash, wallet_id, instrument_code,
    settlement_version, settlement_hash, settlement_authority,
    authenticated_service, authentication_result, ledger_posting_required,
    ledger_instruction_id, ledger_posting_request_id, ledger_journal_id,
    ledger_entry_id, ledger_entry_hash, original_application_id,
    reversal_of_operation_id)
  values (p_reservation_id, p_player_id, p_ticket_id, p_settlement_id,
    p_reversal_amount, p_balance_impact, v_balance_before, v_balance_after,
    p_currency, 'REVERSAL', p_idempotency_key, p_correlation_id,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('reasonCode', p_reason),
    p_operation_id, p_authority, p_instruction_id, p_instruction_sequence,
    p_instruction_hash, p_wallet_id, p_instrument, p_settlement_version,
    p_settlement_hash, p_authority, p_source_service, 'AUTHENTICATED',
    p_ledger_required, p_ledger_instruction_id,
    (v_provenance->>'ledgerPostingRequestId')::uuid,
    (v_provenance->>'ledgerJournalId')::uuid,
    (v_provenance->>'ledgerEntryId')::uuid, v_provenance->>'ledgerEntryHash',
    v_original.id, p_original_operation_id)
  returning * into v_application;

  perform set_config('credit_wallet_service.projection_mutation', 'approved', true);
  update public.credit_reservations
  set captured_amount = captured_amount - p_reversal_amount,
      settled_amount = settled_amount - p_reversal_amount,
      remaining_exposure = remaining_exposure + p_reversal_amount,
      status = v_status, settled_at = null, completed_at = null
  where id = p_reservation_id;
  insert into public.outbox_events(event_type, aggregate_type, aggregate_id, payload, status, correlation_id)
  values ('wallet.settlement.reversed', 'credit_settlement_application', v_application.id::text,
    jsonb_build_object('operationId', p_operation_id,
      'originalOperationId', p_original_operation_id, 'settlementId', p_settlement_id,
      'ledgerInstructionId', p_ledger_instruction_id, 'reservationId', p_reservation_id),
    'PENDING', p_correlation_id);
  return to_jsonb(v_application) || jsonb_build_object(
    'reservationStatus', v_status,
    'remainingExposure', v_reservation.remaining_exposure + p_reversal_amount,
    'authenticationEvidenceHash', v_provenance->>'authenticationEvidenceHash');
end;
$$;

comment on table credit_wallet_service.settlement_instruction_authentication_evidence is
  'Append-only evidence that Credit Wallet authenticated Settlement provenance and enforced explicit Ledger coordination before mutation.';
comment on function credit_wallet_service.reverse_authoritative_wallet_settlement is
  'Creates an opposing wallet/reservation mutation linked to immutable original Settlement and Ledger evidence; it never recalculates settlement.';
