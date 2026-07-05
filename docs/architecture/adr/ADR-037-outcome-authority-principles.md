# ADR-037 - Outcome Authority Principles

## Status

Accepted

## Context

Outcome Authority is the fairness boundary. It must support generic outcome
generation without knowing product economics, payouts, RTP, side bets,
jackpots, or financial settlement.

## Decision

Outcome Authority owns:

- outcome request validation;
- outcome primitive execution;
- outcome strategy execution;
- RNG provider selection within approved governance;
- entropy acquisition;
- replay protection;
- dry-run and simulation labeling;
- outcome canonicalization;
- outcome hash generation;
- outcome signature generation;
- outcome certificate creation;
- append-only outcome persistence;
- outcome custody state.

Outcome Authority never owns:

- RTP;
- paytables;
- payouts;
- prize matrices;
- jackpots;
- side bets;
- derived market payouts;
- settlement records;
- ledger effects;
- financial balances.

Outcome custody states are:

1. Requested
2. Generated
3. Sealed
4. Certified
5. Published
6. Superseded
7. Voided
8. Disputed
9. Replayed

## Rationale

Fairness and economics must be separate. This prevents RTP manipulation through
RNG behavior and makes outcome generation certifiable as a generic authority.

## Consequences

- Outcome generation failures fail closed.
- Simulation and dry-run outcomes can never become production outcomes.
- Outcome certificates are required before Math Authority evaluates production
  tickets.
- Corrected outcomes require supersession evidence, not mutation.
