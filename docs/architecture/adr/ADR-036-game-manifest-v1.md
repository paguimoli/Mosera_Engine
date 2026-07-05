# ADR-036 - Game Manifest v1

## Status

Accepted

## Context

The platform needs a durable game definition model that supports lottery,
Keno, Bullseye, instant games, progressive jackpots, promotional draws, future
casino games, future sportsbook-derived products, and jurisdiction-specific
activation.

## Decision

Game Manifest v1 is the immutable production artifact that binds a playable
product to approved versions of outcome, math, settlement, certification, and
jurisdiction rules.

Required fields:

- manifest id;
- game id/code/name;
- game family;
- jurisdiction bindings;
- operator/brand/market scope;
- sales window rules;
- ticket/wager schemas;
- outcome strategy references;
- RNG provider eligibility;
- math model references;
- paytable references;
- RTP disclosure references;
- settlement policy references;
- cancellation policy;
- correction/supersession policy;
- replay and resettlement policy;
- certification pack reference;
- required certificates;
- lifecycle state;
- effective-from and effective-to;
- version graph;
- canonical manifest hash;
- signing metadata.

## Versioning Strategy

Each material change creates a new manifest version. Material changes include
rules, jurisdiction bindings, outcome strategy, RNG provider eligibility, math
model, paytable, RTP disclosure, settlement policy, certification state, or
operator activation.

Historic tickets always reference the manifest version active at purchase time.
Manifest changes are prospective only.

## Activation Lifecycle

Manifest lifecycle states are:

1. Draft
2. Internal Review
3. Simulation Certified
4. Certification Pending
5. Certified
6. Governance Approved
7. Production Active
8. Suspended
9. Retired
10. Superseded

## Consequences

- Game Manifest v1 becomes the primary product artifact for regulators and
  operators.
- No production draw or settlement may run without an active manifest.
- Version references replace mutable runtime configuration.
- Jurisdiction activation is explicit and auditable.
