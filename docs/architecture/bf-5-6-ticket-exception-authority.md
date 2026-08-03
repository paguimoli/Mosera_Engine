# BF-5.6 Ticket Exception Authority

## Canonical boundary

`ticket_exception_authority` is the sole Ticket Authority boundary for governed post-acceptance void, Settlement reversal, resettlement, canonical Draw cancellation impact, and interrupted-operation recovery. It coordinates existing authorities and never calculates settlement, posts Ledger entries, changes Wallet balances, or calculates Compensation directly.

## Evidence flow

Commands are immutable and conflict-safe by idempotency key plus canonical command hash. Every transition appends an `operation_events` row. `operation_projection` is only a guarded current projection derived from those events. Per-ticket PostgreSQL advisory locks serialize void, reversal, resettlement, cancellation, and recovery.

Unsettled void invokes the canonical Wallet reservation cancellation RPC, binds its immutable release and Wallet operation evidence, and only then appends `VoidTicket` lifecycle evidence. Settled reversal and resettlement consume completed `settlement_service.resettlement_records`, exact original Completion sources, and terminal Ledger and Wallet execution evidence. Amounts are never inferred from current balances.

## Draw cancellation

`process_draw_cancellation` accepts one canonical Outcome lifecycle cancellation event and discovers affected tickets by authoritative `draw_id`. Caller-supplied ticket sets are not accepted. Unsettled tickets are voided; settled tickets remain recoverable until their exact financial reversal evidence is complete.

## Compensation

Original Commission and Rebate records remain immutable. Completed reversal creates separate append-only `REVERSE` adjustment requirements for both strategies. Completed resettlement creates `RECALCULATE` requirements. The Compensation Authority remains responsible for materializing adjustment entitlements.

## Cross-service integrity

The integrated database uses restrictive foreign keys. In separately deployed service databases, the same boundary is enforced through immutable IDs, hashes, idempotency identities, and authoritative service contract validation. No cross-service amount or result is reconstructed from a mutable projection.

## Legacy retirement

Direct `ReverseSettlement`, `ResettleTicket`, `CancelDraw`, and `VoidTicket` lifecycle calls are gated by Ticket Exception Authority evidence. Ordinary pre-cutoff customer cancellation remains a separate canonical ticket operation. Historical legacy tickets remain read-only and cannot enter exception execution.
