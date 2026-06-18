# Phase 13.3 - Settlement Service Shadow Mode

## Purpose

Phase 13.3 creates the first extraction-path Settlement Service in shadow mode. The service can independently calculate a settlement result and compare it with a monolith result, but it is non-authoritative.

## Non-Authoritative Status

The monolith remains the source of truth. The Settlement Service must not:

- update tickets
- release credit exposure
- post ledger entries
- update balances
- emit production financial outbox events
- replace monolith settlement execution

Shadow mode is read-only from a financial-effect perspective.

## Service

Created:

- `services/settlement-service`

Runtime:

- .NET 10 Web API
- host port `5400`
- container port `8080`

Health endpoints:

- `GET /health`
- `GET /health/live`
- `GET /health/ready`

Readiness checks:

- RabbitMQ TCP connectivity
- Redis PING
- database marked `not_configured`

## Shadow Endpoint Contract

Endpoint:

- `POST /v1/settlement/shadow/execute`

Input:

- `correlationId`
- `settlementRunId`
- `ticketId`
- `drawingId`
- `gameId`
- `wagerType`
- `stakeAmount`
- `currency`
- `selectedNumbers`
- `winningNumbers`
- optional `expectedMonolithResult`

Output:

- `success`
- `shadowSettlementId`
- `calculatedOutcome`
- `grossPayout`
- `netAmount`
- `stakeAmount`
- `currency`
- `comparisonStatus`
- `mismatches`
- `correlationId`

Money uses integer minor units only.

## Comparison Model

When `expectedMonolithResult` is supplied, the service compares:

- outcome
- gross payout
- net amount
- stake amount
- currency

Statuses:

- `MATCH`
- `MISMATCH`
- `NOT_COMPARED`

Mismatch responses include field-level expected and actual values.

## Monolith Shadow Client

Created:

- `src/domains/settlement/settlement-shadow-client.ts`

Environment:

- `SETTLEMENT_SHADOW_MODE_ENABLED=false`
- `SETTLEMENT_SERVICE_URL=http://settlement-service:8080`

Behavior:

- best effort only
- failure logs warning
- mismatch logs warning
- success logs summary
- no settlement failure caused by shadow failure
- no production financial effect caused by shadow execution

## Integration Point

The shadow client is invoked after monolith settlement records are produced and before financial boundary effects are finalized. It receives the monolith settlement record as the expected result. The returned shadow summary is attached to the controller response metadata only.

## Operational Visibility

For this phase, operational visibility is log-based:

- attempted count
- match count
- mismatch count
- failure count
- last mismatch timestamp

Persistent shadow metrics are a remaining gap.

## Cutover Path

1. Keep shadow mode disabled by default.
2. Enable shadow mode in a controlled environment.
3. Compare monolith and shadow results across QA and beta traffic.
4. Add persistent shadow metrics and mismatch review workflow.
5. Expand calculator coverage to all settlement wager types.
6. Add feature-flagged routing only after match rates and rollback are proven.

## Remaining Gaps

- The .NET calculator covers deterministic QA selection-match scenarios only.
- No database read model is wired to the Settlement Service.
- No persistent shadow audit table exists.
- No production traffic is routed to the Settlement Service.
- No real financial effects are allowed in the Settlement Service.
