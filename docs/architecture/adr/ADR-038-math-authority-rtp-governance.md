# ADR-038 - Math Authority and RTP Governance

## Status

Accepted

## Context

RTP, paytables, volatility, expected value, and prize matrices are product
economics. They must be governed independently from random outcome generation.

## Decision

Math Authority owns:

- math models;
- RTP;
- expected value;
- volatility;
- hit frequency;
- prize matrices;
- paytables;
- jackpot contribution models;
- bonus game math;
- side bet math;
- derived market math;
- rounding policies;
- currency/minor-unit policies;
- maximum exposure constraints;
- deterministic math evaluation;
- Math Model Certificates;
- Math Evaluation Certificates.

RTP is controlled only by immutable math models and paytables. RNG must never be
manipulated to reach a target RTP.

Changing RTP, paytables, probability tables, volatility, expected value,
jackpot contribution, prize caps, or rounding policy creates a new Math Model
version.

## Required Version References

Every production math evaluation must reference:

- Game Manifest version;
- Outcome Certificate;
- Outcome Strategy version;
- Math Model version;
- Paytable version;
- Rules version;
- Certification version;
- Hash Algorithm version;
- Signing Algorithm version.

## Consequences

- Historic tickets are evaluated against the exact math model version active at
  purchase time.
- Math Authority never generates outcomes or consumes raw entropy.
- Settlement consumes math evaluation results and never recalculates RTP.
- Math simulation evidence is required before production activation.
