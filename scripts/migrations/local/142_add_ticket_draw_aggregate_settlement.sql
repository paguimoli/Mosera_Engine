begin;

alter table game_engine.settlement_input_records
  add column input_kind text not null default 'ITEM'
    check (input_kind in ('ITEM', 'TICKET_DRAW_AGGREGATE'));

create index idx_settlement_input_records_kind
  on game_engine.settlement_input_records(input_kind, issued_at);

create table game_engine.ticket_draw_settlement_aggregates (
  settlement_input_id uuid primary key
    references game_engine.settlement_input_records(settlement_input_id) on delete restrict,
  ticket_id uuid not null references ticket_authority.tickets(ticket_id) on delete restrict,
  draw_id uuid not null references game_engine.durable_scheduler_draws(draw_id) on delete restrict,
  outcome_certificate_id uuid not null references game_engine.outcome_certificates(certificate_id) on delete restrict,
  product_version_id uuid not null references game_engine.game_definition_versions(id) on delete restrict,
  product_version_hash text not null check (product_version_hash ~ '^sha256:[0-9a-f]{64}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  item_count integer not null check (item_count > 0),
  total_reserved_stake_minor bigint not null check (total_reserved_stake_minor > 0),
  pre_cap_gross_return_minor bigint not null check (pre_cap_gross_return_minor >= 0),
  effective_cap_minor bigint check (effective_cap_minor > 0),
  cap_scope text not null check (cap_scope in ('NONE', 'TICKET_DRAW')),
  post_cap_gross_return_minor bigint not null check (post_cap_gross_return_minor >= 0),
  capture_amount_minor bigint not null check (capture_amount_minor > 0),
  release_amount_minor bigint not null check (release_amount_minor >= 0),
  credit_amount_minor bigint not null check (credit_amount_minor >= 0),
  item_evidence_hash text not null check (item_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  canonical_aggregate_hash text not null unique check (canonical_aggregate_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (ticket_id, draw_id, outcome_certificate_id),
  check (post_cap_gross_return_minor <= pre_cap_gross_return_minor),
  check (capture_amount_minor + release_amount_minor = total_reserved_stake_minor),
  check (credit_amount_minor = post_cap_gross_return_minor),
  check (
    (cap_scope = 'NONE' and effective_cap_minor is null and post_cap_gross_return_minor = pre_cap_gross_return_minor)
    or
    (cap_scope = 'TICKET_DRAW' and effective_cap_minor is not null
      and post_cap_gross_return_minor = least(pre_cap_gross_return_minor, effective_cap_minor))
  )
);

create index idx_ticket_draw_settlement_aggregate_product
  on game_engine.ticket_draw_settlement_aggregates(product_version_id, draw_id);

create table game_engine.ticket_draw_settlement_aggregate_items (
  settlement_input_id uuid not null
    references game_engine.ticket_draw_settlement_aggregates(settlement_input_id) on delete restrict,
  ticket_item_id uuid not null references ticket_authority.ticket_items(ticket_item_id) on delete restrict,
  item_index integer not null check (item_index >= 0),
  stake_minor bigint not null check (stake_minor > 0),
  math_evaluation_id uuid not null references game_engine.math_evaluation_events(math_evaluation_id) on delete restrict,
  math_evaluation_certificate_id uuid not null
    references game_engine.math_evaluation_certificates(certificate_id) on delete restrict,
  math_evaluation_certificate_hash text not null check (math_evaluation_certificate_hash ~ '^sha256:[0-9a-f]{64}$'),
  evaluation_outcome text not null check (evaluation_outcome in ('Win', 'Loss', 'Push')),
  prize_tier text not null,
  gross_return_minor bigint not null check (gross_return_minor >= 0),
  refund_return_minor bigint not null check (refund_return_minor >= 0),
  loss_stake_minor bigint not null check (loss_stake_minor >= 0),
  prize_facts_hash text not null check (prize_facts_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (settlement_input_id, ticket_item_id),
  unique (settlement_input_id, item_index),
  unique (settlement_input_id, math_evaluation_id),
  unique (settlement_input_id, math_evaluation_certificate_id),
  check (math_evaluation_certificate_hash = prize_facts_hash),
  check ((evaluation_outcome = 'Push') = (refund_return_minor > 0)),
  check ((evaluation_outcome = 'Loss') = (loss_stake_minor > 0))
);

create index idx_ticket_draw_settlement_items_certificate
  on game_engine.ticket_draw_settlement_aggregate_items(
    math_evaluation_certificate_id, math_evaluation_certificate_hash);

create or replace function game_engine.validate_settlement_input_record()
returns trigger
language plpgsql
as $$
declare
  forbidden text[] := array[
    'balance', 'wallet', 'ledger', 'commission', 'tax', 'cashier',
    'accountId', 'walletId', 'ledgerEntryId', 'transactionId'
  ];
  value text;
  payload_text text;
begin
  if new.input_kind = 'ITEM' and new.math_evaluation_certificate_hash <> new.prize_facts_hash then
    raise exception 'SettlementInput certificate hash must match PrizeFacts hash';
  end if;
  if new.input_kind = 'ITEM'
     and new.canonical_payload->>'mathEvaluationCertificateHash' <> new.math_evaluation_certificate_hash then
    raise exception 'SettlementInput canonical payload certificate hash mismatch';
  end if;
  if new.input_kind = 'ITEM'
     and new.canonical_payload->>'prizeFactsHash' <> new.prize_facts_hash then
    raise exception 'SettlementInput canonical payload PrizeFacts hash mismatch';
  end if;
  if new.input_kind = 'TICKET_DRAW_AGGREGATE'
     and (new.canonical_payload->>'ticketId' is null
       or new.canonical_payload->>'drawId' is null
       or new.canonical_payload->>'itemEvidenceHash' is null
       or jsonb_typeof(new.canonical_payload->'items') <> 'array') then
    raise exception 'Aggregate SettlementInput canonical payload is incomplete';
  end if;

  payload_text := lower(new.prize_facts::text || new.provenance::text || new.canonical_payload::text);
  foreach value in array forbidden loop
    if payload_text like '%' || lower(value) || '%' then
      raise exception 'SettlementInput cannot contain financial or settlement-side reference %', value;
    end if;
  end loop;
  return new;
end;
$$;

create or replace function game_engine.prevent_ticket_draw_aggregate_mutation()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only; % is not allowed.', tg_table_name, tg_op;
end;
$$;

create trigger trg_ticket_draw_settlement_aggregates_immutable
before update or delete on game_engine.ticket_draw_settlement_aggregates
for each row execute function game_engine.prevent_ticket_draw_aggregate_mutation();

create trigger trg_ticket_draw_settlement_aggregate_items_immutable
before update or delete on game_engine.ticket_draw_settlement_aggregate_items
for each row execute function game_engine.prevent_ticket_draw_aggregate_mutation();

create or replace function game_engine.validate_ticket_draw_settlement_aggregate()
returns trigger language plpgsql as $$
declare
  v_aggregate game_engine.ticket_draw_settlement_aggregates%rowtype;
  v_input game_engine.settlement_input_records%rowtype;
  v_product_hash text;
  v_item_count integer;
  v_stake bigint;
  v_gross bigint;
begin
  select * into v_aggregate from game_engine.ticket_draw_settlement_aggregates
  where settlement_input_id = coalesce(new.settlement_input_id, old.settlement_input_id);
  if not found then return null; end if;
  select * into v_input from game_engine.settlement_input_records
  where settlement_input_id = v_aggregate.settlement_input_id;
  select definition_hash into v_product_hash from game_engine.game_definition_versions
  where id = v_aggregate.product_version_id;
  select count(*)::integer, coalesce(sum(stake_minor), 0)::bigint,
         coalesce(sum(gross_return_minor), 0)::bigint
    into v_item_count, v_stake, v_gross
  from game_engine.ticket_draw_settlement_aggregate_items
  where settlement_input_id = v_aggregate.settlement_input_id;
  if v_input.input_kind <> 'TICKET_DRAW_AGGREGATE'
     or v_input.ticket_reference <> v_aggregate.ticket_id::text
     or v_input.outcome_certificate_id <> v_aggregate.outcome_certificate_id
     or v_input.canonical_payload_hash <> v_aggregate.canonical_aggregate_hash
     or v_product_hash <> v_aggregate.product_version_hash
     or v_item_count <> v_aggregate.item_count
     or v_stake <> v_aggregate.total_reserved_stake_minor
     or v_gross <> v_aggregate.pre_cap_gross_return_minor then
    raise exception 'Ticket/draw aggregate SettlementInput evidence is inconsistent';
  end if;
  if exists (
    select 1
    from game_engine.ticket_draw_settlement_aggregate_items item
    join game_engine.math_evaluation_certificates certificate
      on certificate.certificate_id = item.math_evaluation_certificate_id
    join game_engine.math_evaluation_events evaluation
      on evaluation.math_evaluation_id = item.math_evaluation_id
    where item.settlement_input_id = v_aggregate.settlement_input_id
      and (certificate.math_evaluation_id <> item.math_evaluation_id
        or certificate.canonical_prize_facts_hash <> item.math_evaluation_certificate_hash
        or evaluation.canonical_prize_facts_hash <> item.prize_facts_hash
        or evaluation.ticket_reference <> item.ticket_item_id::text)
  ) then
    raise exception 'Ticket/draw aggregate item does not match immutable Math evidence';
  end if;
  return null;
end;
$$;

create constraint trigger trg_ticket_draw_settlement_aggregate_complete
after insert on game_engine.ticket_draw_settlement_aggregates
deferrable initially deferred
for each row execute function game_engine.validate_ticket_draw_settlement_aggregate();

create constraint trigger trg_ticket_draw_settlement_aggregate_items_complete
after insert on game_engine.ticket_draw_settlement_aggregate_items
deferrable initially deferred
for each row execute function game_engine.validate_ticket_draw_settlement_aggregate();

alter table ticket_completion_authority.completion_sources
  drop constraint if exists completion_sources_settlement_id_key,
  drop constraint if exists completion_sources_ledger_execution_attempt_id_key,
  drop constraint if exists completion_sources_ledger_posting_request_id_key,
  drop constraint if exists completion_sources_ledger_entry_id_key,
  drop constraint if exists completion_sources_wallet_execution_attempt_id_key,
  drop constraint if exists completion_sources_wallet_operation_id_key;

do $migration$
declare
  v_definition text;
  v_original text := $original$
    if not found or v_settlement.ticket_id <> p_ticket_id::text
       or v_settlement.ticket_line_id <> v_ticket_item_id::text
       or v_settlement.stake_amount_minor <> v_ticket_item.stake_minor
       or v_settlement.currency <> v_ticket.currency then
      raise exception 'Authoritative Settlement completion does not match the ticket item.';
    end if;
$original$;
  v_replacement text := $replacement$
    if not found or v_settlement.ticket_id <> p_ticket_id::text
       or v_settlement.currency <> v_ticket.currency then
      raise exception 'Authoritative Settlement completion does not match the ticket item.';
    end if;
    if v_settlement.ticket_line_id <> v_ticket_item_id::text
       or v_settlement.stake_amount_minor <> v_ticket_item.stake_minor then
      if not exists (
        select 1
        from game_engine.ticket_draw_settlement_aggregates aggregate
        join game_engine.ticket_draw_settlement_aggregate_items aggregate_item
          on aggregate_item.settlement_input_id = aggregate.settlement_input_id
        where aggregate.settlement_input_id = v_settlement.settlement_input_id
          and aggregate.ticket_id = p_ticket_id
          and aggregate_item.ticket_item_id = v_ticket_item_id
          and aggregate_item.stake_minor = v_ticket_item.stake_minor
          and v_settlement.ticket_line_id = 'aggregate:' || replace(aggregate.draw_id::text, '-', '')
          and v_settlement.stake_amount_minor = aggregate.total_reserved_stake_minor
      ) then
        raise exception 'Authoritative Settlement completion does not match the ticket item or aggregate attribution.';
      end if;
    end if;
$replacement$;
begin
  select pg_get_functiondef(
    'ticket_completion_authority.complete_ticket(uuid,jsonb,text,text,text,text)'::regprocedure
  ) into v_definition;
  if position(v_original in v_definition) = 0 then
    raise exception 'Aggregate completion migration could not locate the authoritative Settlement validation block.';
  end if;
  execute replace(v_definition, v_original, v_replacement);
end;
$migration$;

comment on table game_engine.ticket_draw_settlement_aggregates is
  'Append-only one-per-ticket/draw financial aggregate derived from a complete immutable Math Evaluation Certificate set. Cap values come from the accepted immutable product/paytable lineage.';
comment on table game_engine.ticket_draw_settlement_aggregate_items is
  'Append-only item attribution retained beneath one canonical ticket/draw SettlementInput; these rows never cause independent Wallet mutations.';

commit;
