begin;

create extension if not exists pgcrypto;
create schema if not exists funding_authority;

create or replace function funding_authority.prevent_evidence_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'Funding Instrument Authority evidence is append-only.';
end;
$$;

create table funding_authority.resolution_events (
  resolution_id uuid primary key default gen_random_uuid(),
  player_account_id uuid not null references public.accounts(id),
  funding_instrument text not null check (funding_instrument in ('CREDIT', 'FREE_PLAY')),
  wallet_id uuid not null references public.financial_wallets(id),
  reservation_type text not null
    check (reservation_type in ('CREDIT_EXPOSURE', 'FREE_PLAY_STAKE')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  operation text not null check (operation in ('TICKET_ACCEPTANCE', 'COMPENSATION')),
  idempotency_key text not null unique,
  canonical_request_hash text not null check (canonical_request_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_resolution_hash text not null unique
    check (canonical_resolution_hash ~ '^sha256:[0-9a-f]{64}$'),
  correlation_id text not null,
  created_at timestamptz not null default now()
);

create index idx_funding_resolution_player_instrument
  on funding_authority.resolution_events(
    player_account_id, funding_instrument, created_at desc
  );
create index idx_funding_resolution_wallet
  on funding_authority.resolution_events(wallet_id, created_at desc);

create trigger funding_resolution_update_guard
before update on funding_authority.resolution_events
for each row execute function funding_authority.prevent_evidence_mutation();
create trigger funding_resolution_delete_guard
before delete on funding_authority.resolution_events
for each row execute function funding_authority.prevent_evidence_mutation();

create or replace function funding_authority.resolve_funding_instrument(
  p_player_account_id uuid,
  p_requested_instrument text,
  p_requested_wallet_id uuid,
  p_currency text,
  p_operation text,
  p_idempotency_key text,
  p_correlation_id text
)
returns table(
  resolution_id uuid,
  funding_instrument text,
  wallet_id uuid,
  reservation_type text,
  currency text,
  canonical_resolution_hash text,
  reused boolean
)
language plpgsql
as $$
declare
  v_account public.accounts%rowtype;
  v_wallet public.financial_wallets%rowtype;
  v_scope credit_wallet_service.wallet_scopes%rowtype;
  v_instrument text;
  v_reservation_type text;
  v_request_hash text;
  v_resolution_hash text;
  v_existing funding_authority.resolution_events%rowtype;
  v_resolution_id uuid := gen_random_uuid();
begin
  if p_idempotency_key is null or btrim(p_idempotency_key) = '' then
    raise exception 'Funding resolution idempotency key is required.';
  end if;
  if p_correlation_id is null or btrim(p_correlation_id) = '' then
    raise exception 'Funding resolution correlation id is required.';
  end if;
  if p_operation = 'TICKET_ACCEPTANCE'
     and upper(coalesce(p_currency, '')) !~ '^[A-Z]{3}$' then
    raise exception 'Funding resolution currency is invalid.';
  end if;
  if p_currency is not null
     and upper(p_currency) !~ '^[A-Z]{3}$' then
    raise exception 'Funding resolution currency is invalid.';
  end if;
  if p_operation not in ('TICKET_ACCEPTANCE', 'COMPENSATION') then
    raise exception 'Funding resolution operation is unsupported.';
  end if;
  if p_requested_instrument is not null
     and upper(p_requested_instrument) not in ('CREDIT', 'FREE_PLAY') then
    raise exception 'Only CREDIT and FREE_PLAY funding instruments are supported.';
  end if;

  select * into v_account
  from public.accounts account_record
  where account_record.id = p_player_account_id
    and account_record.governance_managed
    and account_record.status = 'ACTIVE';
  if not found then
    raise exception 'Active governed funding beneficiary was not found.';
  end if;

  if p_requested_wallet_id is not null then
    select * into v_wallet
    from public.financial_wallets wallet_record
    where wallet_record.id = p_requested_wallet_id
      and wallet_record.account_id = p_player_account_id
      and wallet_record.wallet_type in ('CREDIT', 'FREE_PLAY')
      and (
        p_currency is null
        or wallet_record.currency_code = upper(p_currency)
      )
      and wallet_record.status = 'ACTIVE';
  else
    v_instrument := upper(coalesce(
      nullif(p_requested_instrument, ''),
      case
        when v_account.default_funding_source in ('CREDIT', 'FREE_PLAY')
          then v_account.default_funding_source
        when v_account.funding_model = 'CREDIT' then 'CREDIT'
        else null
      end
    ));
    if v_instrument not in ('CREDIT', 'FREE_PLAY') then
      raise exception 'A CREDIT or FREE_PLAY funding instrument must be requested.';
    end if;
    select * into v_wallet
    from public.financial_wallets wallet_record
    where wallet_record.account_id = p_player_account_id
      and wallet_record.wallet_type = v_instrument
      and (
        p_currency is null
        or wallet_record.currency_code = upper(p_currency)
      )
      and wallet_record.status = 'ACTIVE'
    order by wallet_record.id
    limit 1;
  end if;
  if not found then
    raise exception 'An active scoped wallet for the requested funding instrument is required.';
  end if;

  v_instrument := v_wallet.wallet_type;
  if p_requested_instrument is not null
     and upper(p_requested_instrument) <> v_instrument then
    raise exception 'Requested funding instrument does not match the authoritative wallet.';
  end if;

  select * into v_scope
  from credit_wallet_service.wallet_scopes wallet_scope
  where wallet_scope.wallet_id = v_wallet.id
    and wallet_scope.player_id = p_player_account_id
    and wallet_scope.tenant_id = v_account.canonical_tenant_id
    and wallet_scope.brand_id = v_account.canonical_brand_id
    and wallet_scope.instrument_code = v_instrument
    and wallet_scope.currency = v_wallet.currency_code;
  if not found then
    raise exception 'Canonical wallet scope is not registered for funding resolution.';
  end if;

  perform 1
  from credit_wallet_service.wallet_instrument_definitions definition
  where definition.instrument_code = v_instrument
    and definition.lifecycle_state = 'ACTIVE'
    and definition.reservable
    and definition.settlement_supported;
  if not found then
    raise exception 'Funding instrument is not active for reservation and settlement.';
  end if;

  v_reservation_type := case v_instrument
    when 'CREDIT' then 'CREDIT_EXPOSURE'
    when 'FREE_PLAY' then 'FREE_PLAY_STAKE'
  end;
  v_request_hash := 'sha256:' || encode(digest(convert_to(
    jsonb_build_object(
      'currency', v_wallet.currency_code,
      'fundingInstrument', v_instrument,
      'operation', p_operation,
      'playerAccountId', p_player_account_id,
      'reservationType', v_reservation_type,
      'walletId', v_wallet.id
    )::text,
    'UTF8'
  ), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(btrim(p_idempotency_key), 0));
  select * into v_existing
  from funding_authority.resolution_events resolution
  where resolution.idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_existing.canonical_request_hash <> v_request_hash then
      raise exception 'Funding resolution idempotency conflict.';
    end if;
    return query select
      v_existing.resolution_id,
      v_existing.funding_instrument,
      v_existing.wallet_id,
      v_existing.reservation_type,
      v_existing.currency,
      v_existing.canonical_resolution_hash,
      true;
    return;
  end if;

  v_resolution_hash := 'sha256:' || encode(digest(convert_to(
    jsonb_build_object(
      'canonicalRequestHash', v_request_hash,
      'resolutionId', v_resolution_id
    )::text,
    'UTF8'
  ), 'sha256'), 'hex');
  insert into funding_authority.resolution_events(
    resolution_id, player_account_id, funding_instrument, wallet_id,
    reservation_type, currency, operation, idempotency_key,
    canonical_request_hash, canonical_resolution_hash, correlation_id
  ) values (
    v_resolution_id, p_player_account_id, v_instrument, v_wallet.id,
    v_reservation_type, v_wallet.currency_code, p_operation, btrim(p_idempotency_key),
    v_request_hash, v_resolution_hash, btrim(p_correlation_id)
  );

  return query select
    v_resolution_id, v_instrument, v_wallet.id, v_reservation_type,
    v_wallet.currency_code, v_resolution_hash, false;
end;
$$;

alter table ticket_authority.tickets
  add column funding_instrument text,
  add column reservation_type text,
  add column funding_resolution_id uuid
    references funding_authority.resolution_events(resolution_id),
  add column funding_snapshot_hash text;

insert into funding_authority.resolution_events(
  resolution_id, player_account_id, funding_instrument, wallet_id,
  reservation_type, currency, operation, idempotency_key,
  canonical_request_hash, canonical_resolution_hash, correlation_id, created_at
)
select
  gen_random_uuid(),
  ticket.player_account_id,
  wallet.wallet_type,
  ticket.wallet_id,
  case wallet.wallet_type
    when 'CREDIT' then 'CREDIT_EXPOSURE'
    else 'FREE_PLAY_STAKE'
  end,
  ticket.currency,
  'TICKET_ACCEPTANCE',
  'ticket-funding:' || ticket.idempotency_key,
  'sha256:' || encode(digest(convert_to(jsonb_build_object(
    'currency', ticket.currency,
    'fundingInstrument', wallet.wallet_type,
    'operation', 'TICKET_ACCEPTANCE',
    'playerAccountId', ticket.player_account_id,
    'reservationType', case wallet.wallet_type
      when 'CREDIT' then 'CREDIT_EXPOSURE'
      else 'FREE_PLAY_STAKE'
    end,
    'walletId', ticket.wallet_id
  )::text, 'UTF8'), 'sha256'), 'hex'),
  'sha256:' || encode(digest(convert_to(
    ticket.ticket_id::text || '|' || wallet.wallet_type || '|' || ticket.wallet_id::text,
    'UTF8'
  ), 'sha256'), 'hex'),
  ticket.correlation_id,
  ticket.accepted_at
from ticket_authority.tickets ticket
join public.financial_wallets wallet on wallet.id = ticket.wallet_id
on conflict (idempotency_key) do nothing;

update ticket_authority.tickets ticket
set funding_instrument = resolution.funding_instrument,
    reservation_type = resolution.reservation_type,
    funding_resolution_id = resolution.resolution_id,
    funding_snapshot_hash = 'sha256:' || encode(digest(convert_to(
      jsonb_build_object(
        'fundingInstrument', resolution.funding_instrument,
        'fundingResolutionHash', resolution.canonical_resolution_hash,
        'reservationId', ticket.reservation_id,
        'reservationType', resolution.reservation_type,
        'walletId', resolution.wallet_id
      )::text,
      'UTF8'
    ), 'sha256'), 'hex')
from funding_authority.resolution_events resolution
where resolution.idempotency_key = 'ticket-funding:' || ticket.idempotency_key;

alter table ticket_authority.tickets
  alter column funding_instrument set not null,
  alter column reservation_type set not null,
  alter column funding_resolution_id set not null,
  alter column funding_snapshot_hash set not null,
  add constraint ck_ticket_funding_instrument
    check (funding_instrument in ('CREDIT', 'FREE_PLAY')),
  add constraint ck_ticket_reservation_type
    check (
      (funding_instrument = 'CREDIT' and reservation_type = 'CREDIT_EXPOSURE')
      or
      (funding_instrument = 'FREE_PLAY' and reservation_type = 'FREE_PLAY_STAKE')
    ),
  add constraint ck_ticket_funding_snapshot_hash
    check (funding_snapshot_hash ~ '^sha256:[0-9a-f]{64}$');

create index idx_ticket_funding_reporting
  on ticket_authority.tickets(
    tenant_id, brand_id, market_id, funding_instrument, accepted_at desc
  );

create view funding_authority.ticket_totals_by_instrument as
select
  ticket.tenant_id,
  ticket.brand_id,
  ticket.market_id,
  ticket.funding_instrument,
  ticket.currency,
  ticket.status,
  count(*)::bigint as ticket_count,
  coalesce(sum(ticket.total_stake_minor), 0)::bigint as total_stake_minor
from ticket_authority.tickets ticket
group by
  ticket.tenant_id,
  ticket.brand_id,
  ticket.market_id,
  ticket.funding_instrument,
  ticket.currency,
  ticket.status;

create or replace function funding_authority.bind_ticket_funding()
returns trigger language plpgsql as $$
declare
  v_resolution funding_authority.resolution_events%rowtype;
  v_result record;
begin
  select * into v_resolution
  from funding_authority.resolution_events
  where idempotency_key = 'ticket-funding:' || new.idempotency_key;
  if not found then
    select * into v_result
    from funding_authority.resolve_funding_instrument(
      new.player_account_id,
      null,
      new.wallet_id,
      new.currency,
      'TICKET_ACCEPTANCE',
      'ticket-funding:' || new.idempotency_key,
      new.correlation_id
    );
    select * into v_resolution
    from funding_authority.resolution_events
    where resolution_id = v_result.resolution_id;
  end if;
  if v_resolution.player_account_id <> new.player_account_id
     or v_resolution.wallet_id <> new.wallet_id
     or v_resolution.currency <> new.currency then
    raise exception 'Ticket funding resolution does not match accepted ticket scope.';
  end if;
  new.funding_instrument := v_resolution.funding_instrument;
  new.reservation_type := v_resolution.reservation_type;
  new.funding_resolution_id := v_resolution.resolution_id;
  new.funding_snapshot_hash := 'sha256:' || encode(digest(convert_to(
    jsonb_build_object(
      'fundingInstrument', v_resolution.funding_instrument,
      'fundingResolutionHash', v_resolution.canonical_resolution_hash,
      'reservationId', new.reservation_id,
      'reservationType', v_resolution.reservation_type,
      'walletId', v_resolution.wallet_id
    )::text,
    'UTF8'
  ), 'sha256'), 'hex');
  return new;
end;
$$;

create trigger ticket_funding_binding
before insert on ticket_authority.tickets
for each row execute function funding_authority.bind_ticket_funding();

create or replace function funding_authority.guard_ticket_funding_update()
returns trigger language plpgsql as $$
begin
  if row(
    new.funding_instrument, new.reservation_type,
    new.funding_resolution_id, new.funding_snapshot_hash
  ) is distinct from row(
    old.funding_instrument, old.reservation_type,
    old.funding_resolution_id, old.funding_snapshot_hash
  ) then
    raise exception 'Accepted ticket funding snapshot is immutable.';
  end if;
  return new;
end;
$$;

create trigger ticket_funding_update_guard
before update on ticket_authority.tickets
for each row execute function funding_authority.guard_ticket_funding_update();

do $$
declare
  v_identity regprocedure :=
    'ticket_authority.accept_ticket(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,jsonb,text,text,text,text,text)'::regprocedure;
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef(v_identity) into v_definition;
  v_updated := replace(
    v_definition,
    'and wallet_type = ''CREDIT''',
    'and wallet_type in (''CREDIT'', ''FREE_PLAY'')'
  );
  v_updated := replace(
    v_updated,
    E'    ''CREDIT'',',
    E'    v_wallet.wallet_type,'
  );
  if v_updated = v_definition
     or position('v_wallet.wallet_type' in v_updated) = 0
     or position('''FREE_PLAY''' in v_updated) = 0 then
    raise exception 'Canonical ticket funding patch could not be applied safely.';
  end if;
  execute v_updated;
end;
$$;

alter table compensation.configurations
  drop constraint configurations_funding_instrument_check,
  add constraint configurations_funding_instrument_check
    check (funding_instrument in ('CREDIT', 'FREE_PLAY'));

alter table compensation.entitlements
  drop constraint entitlements_funding_instrument_check,
  drop constraint entitlements_check,
  add constraint entitlements_funding_instrument_check
    check (funding_instrument in ('CREDIT', 'FREE_PLAY')),
  add constraint entitlements_check check (
    (strategy = 'COMMISSION'
      and reporting_classification = 'COMMISSION'
      and (
        (funding_instrument = 'CREDIT'
          and ledger_transaction_type = 'AGENT_COMMISSION_ACCRUAL')
        or
        (funding_instrument = 'FREE_PLAY'
          and ledger_transaction_type = 'FREE_PLAY_CREDIT')
      ))
    or
    (strategy = 'REBATE'
      and reporting_classification = 'REBATE'
      and (
        (funding_instrument = 'CREDIT'
          and ledger_transaction_type = 'PLAYER_REBATE_CREDIT')
        or
        (funding_instrument = 'FREE_PLAY'
          and ledger_transaction_type = 'FREE_PLAY_CREDIT')
      ))
  );

drop view compensation.reporting_entitlements;
create view compensation.reporting_entitlements as
select
  entitlement.id,
  entitlement.accounting_period_id,
  entitlement.hierarchy_owner_account_id,
  entitlement.beneficiary_account_id,
  entitlement.reporting_classification,
  entitlement.funding_instrument,
  entitlement.basis_amount_minor,
  entitlement.compensation_amount_minor,
  entitlement.currency,
  entitlement.created_at
from compensation.entitlements entitlement;

insert into ledger_service.financial_posting_rules(
  rule_id, rule_version, instruction_type, originating_authority,
  required_account_roles, debit_account_role, credit_account_role,
  amount_source, currency_policy, reversal_policy, effective_date_policy,
  lifecycle, posting_enabled, readiness_blocker, effective_from, content_hash
)
values
  (
    'FREE_PLAY_SETTLEMENT_PAYOUT', '1.0.0', 'FREE_PLAY_SETTLEMENT_PAYOUT',
    'settlement-service', array['SETTLEMENT_CLEARING', 'FREE_PLAY_LIABILITY'],
    'SETTLEMENT_CLEARING', 'FREE_PLAY_LIABILITY',
    'AUTHORITATIVE_INSTRUCTION_AMOUNT', 'INSTRUCTION_CURRENCY',
    'EXACT_COMPENSATING_JOURNAL', 'INSTRUCTION_EFFECTIVE_AT',
    'ACTIVE', true, null, '2026-01-01T00:00:00Z',
    'sha256:' || encode(digest(
      'FREE_PLAY_SETTLEMENT_PAYOUT|1.0.0|settlement-service', 'sha256'
    ), 'hex')
  ),
  (
    'FREE_PLAY_SETTLEMENT_REFUND', '1.0.0', 'FREE_PLAY_SETTLEMENT_REFUND',
    'settlement-service', array['SETTLEMENT_CLEARING', 'FREE_PLAY_LIABILITY'],
    'SETTLEMENT_CLEARING', 'FREE_PLAY_LIABILITY',
    'AUTHORITATIVE_INSTRUCTION_AMOUNT', 'INSTRUCTION_CURRENCY',
    'EXACT_COMPENSATING_JOURNAL', 'INSTRUCTION_EFFECTIVE_AT',
    'ACTIVE', true, null, '2026-01-01T00:00:00Z',
    'sha256:' || encode(digest(
      'FREE_PLAY_SETTLEMENT_REFUND|1.0.0|settlement-service', 'sha256'
    ), 'hex')
  ),
  (
    'FREE_PLAY_COMMISSION_CREDIT', '1.0.0', 'FREE_PLAY_CREDIT',
    'commission-authority', array[
      'AGENT_COMMISSION_EXPENSE_OR_GGR_ALLOCATION', 'FREE_PLAY_LIABILITY'
    ],
    'AGENT_COMMISSION_EXPENSE_OR_GGR_ALLOCATION', 'FREE_PLAY_LIABILITY',
    'AUTHORITATIVE_INSTRUCTION_AMOUNT', 'INSTRUCTION_CURRENCY',
    'EXACT_COMPENSATING_JOURNAL', 'INSTRUCTION_EFFECTIVE_AT',
    'ACTIVE', true, null, '2026-01-01T00:00:00Z',
    'sha256:' || encode(digest(
      'FREE_PLAY_COMMISSION_CREDIT|1.0.0|commission-authority', 'sha256'
    ), 'hex')
  ),
  (
    'FREE_PLAY_REBATE_CREDIT', '1.0.0', 'FREE_PLAY_CREDIT',
    'rebate-authority', array['PLAYER_REBATE_EXPENSE', 'FREE_PLAY_LIABILITY'],
    'PLAYER_REBATE_EXPENSE', 'FREE_PLAY_LIABILITY',
    'AUTHORITATIVE_INSTRUCTION_AMOUNT', 'INSTRUCTION_CURRENCY',
    'EXACT_COMPENSATING_JOURNAL', 'INSTRUCTION_EFFECTIVE_AT',
    'ACTIVE', true, null, '2026-01-01T00:00:00Z',
    'sha256:' || encode(digest(
      'FREE_PLAY_REBATE_CREDIT|1.0.0|rebate-authority', 'sha256'
    ), 'hex')
  );

comment on schema funding_authority is
  'Canonical CREDIT and FREE_PLAY funding resolution and immutable decision evidence.';
comment on table funding_authority.resolution_events is
  'Immutable authority decisions binding operation, instrument, wallet, reservation type, and currency.';

commit;
