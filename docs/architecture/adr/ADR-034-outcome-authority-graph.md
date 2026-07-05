# ADR-034 - Outcome Authority Graph

## Status

Accepted

## Context

Mosera must support lottery, Keno, Pick games, jackpot games, instant games,
promotional draws, future casino RNG products, and future sportsbook-derived
settlement inputs. These products require a permanent separation between
fairness, mathematics, settlement, financial posting, certification, and
operator governance.

Earlier Game Engine records allowed game modules to own validation, draw
generation, and evaluation. P0-005.1 tightens the long-term architecture so
Outcome Authority produces fair outcomes only and Math Authority owns all
prize/RTP logic.

## Decision

Mosera uses this authority graph:

```text
Governance Authority
  -> Game Definition Authority
  -> Outcome Authority
  -> Math Authority
  -> Settlement Authority
  -> Ledger Authority
```

Governance Authority approves and publishes production versions. It is a
control plane, not an execution engine.

Game Definition Authority owns immutable game manifests, product definitions,
jurisdiction bindings, and lifecycle state.

Outcome Authority owns randomness, outcome primitives, outcome strategies,
outcome certificates, replay protection, and outcome evidence.

Math Authority owns math models, RTP, paytables, volatility, expected value, hit
frequency, prize matrices, jackpot contribution, derived markets, and math
evaluation evidence.

Settlement Authority owns settlement records, resettlement, reversal, payout
application state, and settlement certificates.

Ledger Authority owns immutable financial ledger entries and financial
certificates.

## Rationale

This graph prevents RNG from being used to control RTP, prevents settlement from
changing outcomes, and prevents financial services from reinterpreting game
math. It also creates regulator-friendly evidence boundaries.

## Consequences

- Outcome Authority never knows money, payouts, RTP, paytables, or settlement.
- Math Authority never generates randomness.
- Settlement consumes math results and never changes outcomes.
- Ledger is the financial source of truth and never derives game results.
- Governance must sign production activation decisions for every authority.
- Existing implementation may remain consolidated temporarily, but contracts
  must follow this authority graph.
