create schema if not exists credit_wallet_service;

create table credit_wallet_service.wallet_instrument_definitions (
  instrument_code text primary key,
  instrument_version text not null,
  reservable boolean not null,
  withdrawable boolean not null,
  expires boolean not null,
  allows_negative boolean not null,
  settlement_supported boolean not null,
  lifecycle_state text not null default 'ACTIVE' check (lifecycle_state in ('ACTIVE', 'RETIRED')),
  content_hash text not null unique check (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  check (instrument_code in ('CASH', 'CREDIT', 'FREE_PLAY'))
);

insert into credit_wallet_service.wallet_instrument_definitions (
  instrument_code, instrument_version, reservable, withdrawable, expires,
  allows_negative, settlement_supported, content_hash
)
values
  ('CASH', '1.0.0', true, true, false, false, true,
   'sha256:41c40adfeee80c4bfc8152da174c9ebbacd3c525dedb232f74cf838976b30d4f'),
  ('CREDIT', '1.0.0', true, false, false, true, true,
   'sha256:3cc2aba4b51e228c311193168f28d38a27f6eea4b23d3210dc72b0f39d55c03c'),
  ('FREE_PLAY', '1.0.0', true, false, true, false, true,
   'sha256:a621905fefb8c14f42998b17dff823bffab6c8c92a6888920547c29986ca10de');

create table credit_wallet_service.wallet_scopes (
  wallet_id uuid primary key references public.financial_wallets(id),
  tenant_id uuid not null references platform.tenants(id),
  brand_id uuid not null references platform.brands(id),
  player_id uuid not null references public.accounts(id),
  instrument_code text not null references credit_wallet_service.wallet_instrument_definitions(instrument_code),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  authority text not null,
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, brand_id, player_id, instrument_code, currency)
);

create index idx_wallet_scopes_tenant_brand_player
  on credit_wallet_service.wallet_scopes(tenant_id, brand_id, player_id);
create index idx_wallet_scopes_instrument
  on credit_wallet_service.wallet_scopes(instrument_code, currency);

create table credit_wallet_service.wallet_operation_requests (
  operation_id uuid primary key,
  request_id uuid not null unique,
  idempotency_key text not null unique,
  canonical_request_hash text not null check (canonical_request_hash ~ '^sha256:[0-9a-f]{64}$'),
  operation_type text not null check (operation_type in ('ISSUE', 'RESERVE', 'RELEASE', 'SETTLE', 'REVERSE', 'EXPIRE')),
  authority text not null,
  tenant_id uuid not null references platform.tenants(id),
  brand_id uuid not null references platform.brands(id),
  player_id uuid not null references public.accounts(id),
  wallet_id uuid not null references public.financial_wallets(id),
  instrument_code text not null references credit_wallet_service.wallet_instrument_definitions(instrument_code),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint not null check (amount_minor > 0),
  balance_impact_minor bigint,
  ticket_id uuid,
  reservation_id uuid,
  settlement_id uuid,
  settlement_batch_id uuid,
  settlement_outcome text check (settlement_outcome is null or settlement_outcome in ('WIN', 'LOSS', 'PUSH', 'VOID', 'REFUND')),
  original_operation_id uuid references credit_wallet_service.wallet_operation_requests(operation_id),
  reason_code text,
  source_service text,
  effective_at timestamptz not null,
  correlation_id text not null,
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index idx_wallet_operation_requests_scope
  on credit_wallet_service.wallet_operation_requests(tenant_id, brand_id, player_id, wallet_id);
create index idx_wallet_operation_requests_operation
  on credit_wallet_service.wallet_operation_requests(operation_type, instrument_code, created_at);
create index idx_wallet_operation_requests_hash
  on credit_wallet_service.wallet_operation_requests(canonical_request_hash);
create index idx_wallet_operation_requests_reservation
  on credit_wallet_service.wallet_operation_requests(reservation_id) where reservation_id is not null;
create index idx_wallet_operation_requests_settlement
  on credit_wallet_service.wallet_operation_requests(settlement_id) where settlement_id is not null;

create table credit_wallet_service.wallet_operation_attempts (
  attempt_id uuid primary key,
  operation_id uuid not null references credit_wallet_service.wallet_operation_requests(operation_id),
  attempt_number integer not null check (attempt_number > 0),
  result text not null check (result in ('SUCCEEDED', 'FAILED', 'REUSED', 'CONFLICT')),
  started_at timestamptz not null,
  completed_at timestamptz not null check (completed_at >= started_at),
  failure_code text,
  failure_reason text,
  canonical_evidence_hash text not null unique check (canonical_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (operation_id, attempt_number)
);

create index idx_wallet_operation_attempts_operation
  on credit_wallet_service.wallet_operation_attempts(operation_id, attempt_number);

create table credit_wallet_service.wallet_operation_terminal_results (
  terminal_result_id uuid primary key,
  operation_id uuid not null unique references credit_wallet_service.wallet_operation_requests(operation_id),
  terminal_status text not null check (terminal_status in ('COMMITTED', 'FAILED')),
  effect_reference_type text,
  effect_reference_id text,
  result_payload jsonb not null,
  result_hash text not null unique check (result_hash ~ '^sha256:[0-9a-f]{64}$'),
  failure_code text,
  failure_reason text,
  completed_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (
    (terminal_status = 'COMMITTED' and failure_code is null and failure_reason is null)
    or (terminal_status = 'FAILED' and failure_code is not null)
  )
);

create index idx_wallet_operation_terminal_results_status
  on credit_wallet_service.wallet_operation_terminal_results(terminal_status, completed_at);

create or replace function credit_wallet_service.validate_wallet_scope()
returns trigger
language plpgsql
as $$
declare
  v_wallet public.financial_wallets%rowtype;
  v_brand_tenant uuid;
begin
  select * into v_wallet from public.financial_wallets where id = new.wallet_id;
  if not found then raise exception 'Wallet scope wallet was not found.'; end if;

  select tenant_id into v_brand_tenant from platform.brands where id = new.brand_id;
  if not found or v_brand_tenant <> new.tenant_id then
    raise exception 'Wallet scope brand does not belong to tenant.';
  end if;
  if v_wallet.account_id <> new.player_id then raise exception 'Wallet scope player does not own wallet.'; end if;
  if v_wallet.wallet_type <> new.instrument_code then raise exception 'Wallet scope instrument does not match wallet.'; end if;
  if v_wallet.currency_code <> new.currency then raise exception 'Wallet scope currency does not match wallet.'; end if;
  return new;
end;
$$;

create or replace function credit_wallet_service.validate_wallet_operation_request()
returns trigger
language plpgsql
as $$
declare
  v_scope credit_wallet_service.wallet_scopes%rowtype;
  v_instrument credit_wallet_service.wallet_instrument_definitions%rowtype;
begin
  select * into v_scope from credit_wallet_service.wallet_scopes where wallet_id = new.wallet_id;
  if not found then raise exception 'Canonical wallet scope is not registered.'; end if;
  if row(v_scope.tenant_id, v_scope.brand_id, v_scope.player_id, v_scope.instrument_code, v_scope.currency)
     is distinct from row(new.tenant_id, new.brand_id, new.player_id, new.instrument_code, new.currency) then
    raise exception 'Canonical wallet operation scope does not match wallet scope.';
  end if;

  select * into v_instrument
  from credit_wallet_service.wallet_instrument_definitions
  where instrument_code = new.instrument_code and lifecycle_state = 'ACTIVE';
  if not found then raise exception 'Wallet instrument is not active.'; end if;
  if new.operation_type in ('RESERVE', 'RELEASE') and not v_instrument.reservable then
    raise exception 'Wallet instrument does not support reservations.';
  end if;
  if new.operation_type = 'SETTLE' and not v_instrument.settlement_supported then
    raise exception 'Wallet instrument does not support settlement.';
  end if;
  if new.operation_type = 'EXPIRE' and not v_instrument.expires then
    raise exception 'Wallet instrument does not support expiry.';
  end if;
  if new.operation_type = 'RESERVE' and new.ticket_id is null then raise exception 'RESERVE requires ticket_id.'; end if;
  if new.operation_type in ('RELEASE', 'SETTLE') and (new.ticket_id is null or new.reservation_id is null) then
    raise exception 'RELEASE and SETTLE require ticket_id and reservation_id.';
  end if;
  if new.operation_type = 'SETTLE' and (new.settlement_id is null or new.settlement_batch_id is null or new.settlement_outcome is null) then
    raise exception 'SETTLE requires settlement identity and outcome.';
  end if;
  if new.operation_type = 'SETTLE' and (new.balance_impact_minor is null or new.balance_impact_minor = 0) then
    raise exception 'SETTLE requires a non-zero balance impact.';
  end if;
  if new.operation_type = 'REVERSE' and new.original_operation_id is null then
    raise exception 'REVERSE requires original_operation_id.';
  end if;
  return new;
end;
$$;

create or replace function credit_wallet_service.prevent_evidence_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'Credit Wallet operational evidence is append-only.';
end;
$$;

create trigger wallet_scope_validate before insert on credit_wallet_service.wallet_scopes
for each row execute function credit_wallet_service.validate_wallet_scope();
create trigger wallet_scope_update_guard before update on credit_wallet_service.wallet_scopes
for each row execute function credit_wallet_service.prevent_evidence_mutation();
create trigger wallet_scope_delete_guard before delete on credit_wallet_service.wallet_scopes
for each row execute function credit_wallet_service.prevent_evidence_mutation();

create trigger wallet_instruments_update_guard before update on credit_wallet_service.wallet_instrument_definitions
for each row execute function credit_wallet_service.prevent_evidence_mutation();
create trigger wallet_instruments_delete_guard before delete on credit_wallet_service.wallet_instrument_definitions
for each row execute function credit_wallet_service.prevent_evidence_mutation();
create trigger wallet_operation_request_validate before insert on credit_wallet_service.wallet_operation_requests
for each row execute function credit_wallet_service.validate_wallet_operation_request();
create trigger wallet_operation_requests_update_guard before update on credit_wallet_service.wallet_operation_requests
for each row execute function credit_wallet_service.prevent_evidence_mutation();
create trigger wallet_operation_requests_delete_guard before delete on credit_wallet_service.wallet_operation_requests
for each row execute function credit_wallet_service.prevent_evidence_mutation();
create trigger wallet_operation_attempts_update_guard before update on credit_wallet_service.wallet_operation_attempts
for each row execute function credit_wallet_service.prevent_evidence_mutation();
create trigger wallet_operation_attempts_delete_guard before delete on credit_wallet_service.wallet_operation_attempts
for each row execute function credit_wallet_service.prevent_evidence_mutation();
create trigger wallet_operation_terminal_results_update_guard before update on credit_wallet_service.wallet_operation_terminal_results
for each row execute function credit_wallet_service.prevent_evidence_mutation();
create trigger wallet_operation_terminal_results_delete_guard before delete on credit_wallet_service.wallet_operation_terminal_results
for each row execute function credit_wallet_service.prevent_evidence_mutation();

alter table public.credit_reservation_releases
  drop constraint if exists credit_reservation_releases_reservation_id_fkey;
alter table public.credit_reservation_releases
  add constraint credit_reservation_releases_reservation_id_fkey
  foreign key (reservation_id) references public.credit_reservations(id);

alter table public.credit_settlement_applications
  drop constraint if exists credit_settlement_applications_reservation_id_fkey;
alter table public.credit_settlement_applications
  add constraint credit_settlement_applications_reservation_id_fkey
  foreign key (reservation_id) references public.credit_reservations(id);

alter table public.credit_reservations
  drop constraint if exists credit_reservations_player_id_fkey;
alter table public.credit_reservations
  add constraint credit_reservations_player_id_fkey
  foreign key (player_id) references public.accounts(id);

alter table public.credit_settlement_applications
  drop constraint if exists credit_settlement_applications_player_id_fkey;
alter table public.credit_settlement_applications
  add constraint credit_settlement_applications_player_id_fkey
  foreign key (player_id) references public.accounts(id);

alter table public.credit_reservations
  add constraint credit_reservations_exposure_equation
  check (remaining_exposure = reserved_amount - released_amount - settled_amount);
alter table public.credit_reservations
  add constraint credit_reservations_component_bounds
  check (released_amount + settled_amount <= reserved_amount and amount = reserved_amount);

create trigger credit_reservation_releases_update_guard before update on public.credit_reservation_releases
for each row execute function credit_wallet_service.prevent_evidence_mutation();
create trigger credit_reservation_releases_delete_guard before delete on public.credit_reservation_releases
for each row execute function credit_wallet_service.prevent_evidence_mutation();
create trigger credit_settlement_applications_update_guard before update on public.credit_settlement_applications
for each row execute function credit_wallet_service.prevent_evidence_mutation();
create trigger credit_settlement_applications_delete_guard before delete on public.credit_settlement_applications
for each row execute function credit_wallet_service.prevent_evidence_mutation();

comment on schema credit_wallet_service is
  'Credit Wallet Authority operational state bindings and immutable canonical operation evidence.';
comment on table credit_wallet_service.wallet_instrument_definitions is
  'Immutable data-driven operational characteristics for CASH, CREDIT, and FREE_PLAY instruments.';
comment on table credit_wallet_service.wallet_scopes is
  'Immutable tenant/brand/player/instrument ownership binding for an existing mutable wallet.';
comment on table credit_wallet_service.wallet_operation_requests is
  'Immutable canonical wallet operation requests. Current wallet and reservation state remain mutable projections.';
comment on table credit_wallet_service.wallet_operation_attempts is
  'Append-only execution, reuse, conflict, and failure evidence for canonical wallet operations.';
comment on table credit_wallet_service.wallet_operation_terminal_results is
  'One immutable terminal result per canonical wallet operation request.';
