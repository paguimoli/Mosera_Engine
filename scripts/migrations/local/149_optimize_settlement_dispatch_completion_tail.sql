begin;

create index if not exists idx_outbox_events_dispatch_claim
  on public.outbox_events (
    (case when lower(event_type) = 'settlement.requested' then 0 else 1 end),
    created_at,
    id
  )
  where status in ('PENDING', 'FAILED');

create index if not exists idx_ticket_draw_settlement_items_ticket
  on game_engine.ticket_draw_settlement_aggregate_items (
    ticket_item_id,
    settlement_input_id
  );

create index if not exists idx_authoritative_settlement_completion_ticket
  on settlement_service.authoritative_settlement_records (
    ticket_id,
    issued_at,
    settlement_id
  )
  include (ticket_line_id, settlement_input_id);

commit;
