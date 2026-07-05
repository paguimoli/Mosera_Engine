# ADR-041 - Outcome DSL v1

## Status

Accepted

## Context

Outcome Authority must support many products without embedding game-specific
branches into the RNG path. A small declarative DSL can describe generic
outcome primitives while keeping payout and RTP logic out of outcome
generation.

## Decision

Outcome DSL v1 is a constrained declarative language for outcome primitives and
composition.

Supported concepts:

- unique number set;
- ordered number sequence;
- unique symbol set;
- ordered symbol sequence;
- weighted selection;
- decimal draw;
- binary draw;
- shuffle/permutation;
- urn/bag/deck draw;
- composite outcome;
- constraint validation;
- canonical output schema.

Outcome DSL v1 must not contain:

- RTP;
- payout amounts;
- paytables;
- jackpot logic;
- side bet payouts;
- settlement rules;
- ledger rules;
- player/account state.

## Rationale

A constrained Outcome DSL makes outcome generation product-agnostic,
certifiable, and reusable across game families. It also reduces the risk of
game-specific RNG manipulation.

## Consequences

- Outcome strategies are versioned artifacts.
- Outcome DSL execution must be deterministic given RNG draws and strategy
  version.
- Production Outcome DSL versions require Governance Approval Certificates.
- Simulation may use Outcome DSL, but simulation output can never be promoted
  to production outcome authority.
