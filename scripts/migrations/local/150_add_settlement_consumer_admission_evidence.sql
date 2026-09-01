begin;

alter table game_engine.canonical_settlement_event_processing_evidence
  add column consumer_callback_entered_at timestamptz,
  add column execution_slot_requested_at timestamptz,
  add column execution_slot_acquired_at timestamptz,
  add column handler_started_at timestamptz,
  add column consumer_instance_id text,
  add column consumer_prefetch integer,
  add column consumer_execution_concurrency integer,
  add column active_handlers_at_start integer,
  add column waiting_handlers_at_start integer,
  add constraint chk_canonical_settlement_consumer_admission_order check (
    (consumer_received_at is null or consumer_callback_entered_at is null
      or consumer_callback_entered_at >= consumer_received_at)
    and (consumer_callback_entered_at is null or execution_slot_requested_at is null
      or execution_slot_requested_at >= consumer_callback_entered_at)
    and (execution_slot_requested_at is null or execution_slot_acquired_at is null
      or execution_slot_acquired_at >= execution_slot_requested_at)
    and (execution_slot_acquired_at is null or handler_started_at is null
      or handler_started_at >= execution_slot_acquired_at)
    and (handler_started_at is null or consumer_processing_started_at is null
      or consumer_processing_started_at >= handler_started_at)
  ),
  add constraint chk_canonical_settlement_consumer_capacity check (
    (consumer_prefetch is null or consumer_prefetch between 1 and 32)
    and (consumer_execution_concurrency is null
      or consumer_execution_concurrency between 1 and 32)
    and (consumer_prefetch is null or consumer_execution_concurrency is null
      or consumer_execution_concurrency <= consumer_prefetch)
    and (active_handlers_at_start is null or active_handlers_at_start between 1 and 32)
    and (waiting_handlers_at_start is null or waiting_handlers_at_start between 0 and 100000)
  );

comment on column game_engine.canonical_settlement_event_processing_evidence.consumer_callback_entered_at is
  'Timestamp at RabbitMQ callback entry; AMQP delivery and callback entry are the same observable boundary in this consumer.';
comment on column game_engine.canonical_settlement_event_processing_evidence.execution_slot_requested_at is
  'Timestamp immediately before bounded Settlement execution admission is requested.';
comment on column game_engine.canonical_settlement_event_processing_evidence.execution_slot_acquired_at is
  'Timestamp after bounded Settlement execution admission is granted.';
comment on column game_engine.canonical_settlement_event_processing_evidence.handler_started_at is
  'Timestamp immediately before canonical Settlement handler invocation.';
comment on column game_engine.canonical_settlement_event_processing_evidence.consumer_instance_id is
  'Non-secret worker instance identity that received this Settlement delivery.';
comment on column game_engine.canonical_settlement_event_processing_evidence.consumer_prefetch is
  'Bounded RabbitMQ prefetch configured for the receiving Settlement consumer.';
comment on column game_engine.canonical_settlement_event_processing_evidence.consumer_execution_concurrency is
  'Bounded execution concurrency configured for the receiving Settlement consumer.';
comment on column game_engine.canonical_settlement_event_processing_evidence.active_handlers_at_start is
  'Process-local active handler count immediately after this message acquired execution admission.';
comment on column game_engine.canonical_settlement_event_processing_evidence.waiting_handlers_at_start is
  'Process-local execution-admission waiter count immediately after this message acquired a slot.';

commit;
