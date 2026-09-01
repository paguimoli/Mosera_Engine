begin;

alter table game_engine.canonical_settlement_event_processing_evidence
  add column dispatcher_seen_at timestamptz,
  add column publish_started_at timestamptz,
  add column publish_confirmed_at timestamptz,
  add column consumer_received_at timestamptz,
  add column consumer_processing_started_at timestamptz,
  add constraint chk_canonical_settlement_transport_timing_order check (
    (outbox_created_at is null or dispatcher_seen_at is null
      or dispatcher_seen_at >= outbox_created_at)
    and (dispatcher_seen_at is null or publish_started_at is null
      or publish_started_at >= dispatcher_seen_at)
    and (publish_started_at is null or publish_confirmed_at is null
      or publish_confirmed_at >= publish_started_at)
    and (publish_started_at is null or consumer_received_at is null
      or consumer_received_at >= publish_started_at)
    and (consumer_received_at is null or consumer_processing_started_at is null
      or consumer_processing_started_at >= consumer_received_at)
    and (consumer_processing_started_at is null or connection_requested_at is null
      or connection_requested_at >= consumer_processing_started_at)
  );

comment on column game_engine.canonical_settlement_event_processing_evidence.dispatcher_seen_at is
  'Timestamp carried from the canonical dispatcher cycle that first selected this delivery attempt.';
comment on column game_engine.canonical_settlement_event_processing_evidence.publish_started_at is
  'Timestamp immediately before the canonical RabbitMQ publisher wrote the message.';
comment on column game_engine.canonical_settlement_event_processing_evidence.publish_confirmed_at is
  'Timestamp recorded after RabbitMQ publisher confirmation and before durable outbox acknowledgement persistence.';
comment on column game_engine.canonical_settlement_event_processing_evidence.consumer_received_at is
  'Timestamp at which RabbitMQ delivered the message to the canonical consumer callback.';
comment on column game_engine.canonical_settlement_event_processing_evidence.consumer_processing_started_at is
  'Timestamp at which bounded consumer admission completed and canonical handler execution began.';

commit;
