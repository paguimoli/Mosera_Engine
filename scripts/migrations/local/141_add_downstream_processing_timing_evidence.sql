alter table game_engine.canonical_settlement_event_processing_evidence
  add column outbox_created_at timestamptz,
  add column outbox_published_at timestamptz,
  add column consumed_at timestamptz,
  add column processing_started_at timestamptz,
  add column processing_completed_at timestamptz,
  add constraint chk_canonical_settlement_processing_timing_order
    check (
      (outbox_created_at is null or outbox_published_at is null
        or outbox_published_at >= outbox_created_at)
      and (outbox_published_at is null or consumed_at is null
        or consumed_at >= outbox_published_at)
      and (consumed_at is null or processing_started_at is null
        or processing_started_at >= consumed_at)
      and (processing_started_at is null or processing_completed_at is null
        or processing_completed_at >= processing_started_at)
    );

create index idx_canonical_settlement_processing_latency
  on game_engine.canonical_settlement_event_processing_evidence(
    settlement_request_id, processing_completed_at desc)
  where processing_completed_at is not null;

comment on column game_engine.canonical_settlement_event_processing_evidence.outbox_created_at is
  'Immutable source outbox creation timestamp copied when this processing attempt completes.';
comment on column game_engine.canonical_settlement_event_processing_evidence.outbox_published_at is
  'Immutable source outbox publication timestamp copied when this processing attempt completes.';
comment on column game_engine.canonical_settlement_event_processing_evidence.consumed_at is
  'Timestamp at which the canonical Settlement consumer received this attempt.';
comment on column game_engine.canonical_settlement_event_processing_evidence.processing_started_at is
  'Timestamp at which canonical Settlement processing began for this attempt.';
comment on column game_engine.canonical_settlement_event_processing_evidence.processing_completed_at is
  'Timestamp at which canonical Settlement processing ended for this attempt.';
