# Settlement Service Contract

## Purpose

This contract defines the internal Settlement boundary that will later map to an extracted Settlement Service. Production traffic remains in the monolith in Phase 13.1.

## Ownership

Settlement owns:

- Settlement execution orchestration.
- Settlement result application.
- Settlement recovery and resume behavior.
- Resettlement and reversal orchestration as it matures.
- Settlement audit traceability and emitted settlement events.

Settlement does not own credit reservation math, ledger balance posting, wallet policy, commission calculation, accounting close, player lifecycle, cashier lifecycle, or authentication.

## Commands

### Execute Settlement

Internal entry point: `executeSettlement`

Input:

- Settlement run.
- Drawing and game identifiers.
- Eligible tickets and ticket lines.
- Wager definitions and pay table data.
- Official result data.
- Optional existing settlement records.
- Optional execution ID.

Output:

- Settlement execution summary.
- Settlement records.
- Updated ticket and line states.
- Execution errors.

Requirements:

- Uses integer minor-unit money values.
- Does not directly write credit or ledger repositories.
- Credit-backed records are applied through the credit settlement adapter.

Events:

- Settlement events through existing outbox paths where integrated.

External endpoint mapping:

- `POST /v1/settlements/runs/{runId}/execute`

### Resume Settlement

Internal entry point: `resumeSettlement`

Input:

- Same contract as execute settlement.

Output:

- Settlement execution result with recovery execution ID.

Retry safety:

- Existing settlement records must prevent duplicate line processing.

External endpoint mapping:

- `POST /v1/settlements/runs/{runId}/resume`

### Apply Settlement Results

Internal entry point: `applySettlementResults`

Input:

- Settlement records.
- Tickets.
- Currency.
- Optional correlation ID.

Output:

- Per-record credit application results.

Requirements:

- Only credit-backed tickets with reservation IDs are applied to Credit Wallet.
- Non-credit tickets remain unchanged.
- Credit release failures must be visible and not silently treated as complete.

External endpoint mapping:

- `POST /v1/settlements/results/apply`

### Reverse Or Resettle

Internal entry points:

- `reverseSettlementRecordsForResettlement`
- `executeResettlement`

Current status:

- Available in monolith as resettlement helpers.
- Future extracted service requires a stronger persisted contract before routing production traffic.

External endpoint mapping:

- `POST /v1/settlements/runs/{runId}/resettle`

## Correlation And Actor Requirements

Settlement execution should carry a correlation ID from result posting through credit application, ledger effects, audit records, and outbox events. Actor requirements depend on whether settlement is automated, manual, or resettlement-driven.

## Extraction Notes

The first extracted Settlement Service should call Credit Wallet and Ledger boundaries instead of importing repositories. The current monolith still contains legacy in-memory settlement ledger helpers that must be replaced or isolated before extraction.
