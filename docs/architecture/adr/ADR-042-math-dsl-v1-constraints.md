# ADR-042 - Math DSL v1 Constraints

## Status

Accepted

## Context

Math Authority needs reusable, certifiable math models across lottery, Keno,
instant games, casino-style products, promotions, and future sportsbook-derived
products. A fully general programming language would increase certification and
security risk.

## Decision

Math DSL v1 is a constrained deterministic expression model, not a general
programming language.

Allowed concepts:

- hit counting;
- pattern matching;
- prize table lookup;
- derived metric calculation;
- bonus rule evaluation;
- jackpot contribution formula;
- rounding policy;
- currency/minor-unit policy;
- maximum prize/exposure caps;
- jurisdiction-specific disclosure metadata.

Forbidden concepts:

- random number generation;
- network calls;
- filesystem access;
- time-dependent evaluation;
- mutable global state;
- dynamic code loading;
- direct settlement mutation;
- direct ledger mutation.

## Rationale

The Math DSL must be expressive enough for game math while remaining
certifiable, deterministic, explainable, and performant.

## Consequences

- Math DSL versions require simulation evidence before production approval.
- Compiled or cached execution is allowed only if it preserves deterministic
  canonical behavior.
- Math DSL must emit explainable evaluation facts, not just a final prize.
- General-purpose scripting remains prohibited in production math authority.
