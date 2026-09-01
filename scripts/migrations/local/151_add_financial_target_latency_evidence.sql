alter table settlement_service.financial_instruction_execution_attempts
  add column target_request_started_at timestamptz,
  add column target_service_received_at timestamptz,
  add column target_service_completed_at timestamptz,
  add column target_response_received_at timestamptz,
  add constraint financial_instruction_target_timing_order check (
    target_request_started_at is null
    or (
      target_response_received_at is not null
      and target_response_received_at >= target_request_started_at
      and (target_service_received_at is null
        or target_service_received_at >= target_request_started_at)
      and (target_service_completed_at is null
        or target_service_received_at is not null
        and target_service_completed_at >= target_service_received_at)
      and (target_service_completed_at is null
        or target_response_received_at >= target_service_completed_at)
    )
  );

comment on column settlement_service.financial_instruction_execution_attempts.target_request_started_at is
  'PR-05O Settlement client timestamp immediately before the canonical target HTTP request.';
comment on column settlement_service.financial_instruction_execution_attempts.target_service_received_at is
  'PR-05O canonical target service timestamp when the HTTP handler receives the request.';
comment on column settlement_service.financial_instruction_execution_attempts.target_service_completed_at is
  'PR-05O canonical target service timestamp after durable authority work and before response serialization.';
comment on column settlement_service.financial_instruction_execution_attempts.target_response_received_at is
  'PR-05O Settlement client timestamp after the complete canonical target response body is received.';
