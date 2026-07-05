# ADR-043 - Simulation Service Separation

## Status

Accepted

## Context

Mosera needs large-scale RTP validation, prize distribution validation,
volatility analysis, regression testing, and certification support. These
activities require heavy computation and deterministic or pseudo-random test
modes that must never be confused with production outcome authority.

## Decision

Simulation Service is a separate authority-support service. It is not a
production authority.

It supports:

- Monte Carlo simulation;
- RTP validation;
- prize distribution validation;
- volatility analysis;
- hit frequency analysis;
- jackpot liability simulation;
- math model regression;
- outcome primitive distribution tests;
- certification reports.

Simulation Service may consume:

- draft or approved Game Manifests;
- Outcome DSL versions;
- Math DSL versions;
- deterministic test RNG;
- simulation-only RNG profiles.

Simulation Service must never:

- certify production outcomes;
- publish production outcomes;
- post settlement records;
- post ledger entries;
- generate production authority certificates;
- mutate production authority state.

## Rationale

Simulation is essential for certification and product confidence, but it is
dangerous if it can become a production path. Separation preserves evidence
value without compromising authority boundaries.

## Consequences

- Simulation output is evidence, not authority.
- Simulation artifacts must be labeled as non-production.
- Governance can require simulation evidence before activation.
- Production systems must reject simulation certificates as authority inputs.
