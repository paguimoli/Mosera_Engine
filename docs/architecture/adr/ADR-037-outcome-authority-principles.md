# ADR-037 - Outcome Authority Principles

## Status

Accepted

## Context

Outcome Authority is the fairness boundary. It must support generic outcome
generation without knowing product economics, payouts, RTP, side bets,
jackpots, or financial settlement.

## Decision

Outcome Authority owns:

- official draw completion evidence;
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
- outcome custody state;
- immutable publication, correction, cancellation, and supersession versions;
- outbox-backed requests that hand canonical outcomes to Settlement.

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

Settlement can consume an outcome only after Outcome Authority has appended a
canonical publication version. The canonical draw lifecycle is:

1. Draw Scheduled
2. Draw Open
3. Draw Closed
4. Outcome Generated
5. Outcome Validated
6. Outcome Published
7. Settlement Requested
8. Settlement Consumed
9. Draw Completed

Steps 4 through 9 are evidenced by the approved provider result, Outcome
Certificate, immutable canonical outcome version, certificate-backed
`SettlementInput`, `settlement.requested` outbox event, Settlement worker
receipt, and draw completion record. Draw completion cannot precede canonical
Settlement request consumption.

There is no direct Game Engine call to Settlement. The shared outbox is the
authoritative delivery boundary.

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
- Cancelled outcomes are terminal and emit a cancellation request without a
  financial `SettlementInput`.
- Duplicate publication and Settlement emission return their existing durable
  records only when canonical request hashes match. Conflicts fail closed.
- Publication uses a per-draw PostgreSQL advisory transaction lock. Each draw
  has one ordered immutable version chain.

## Runtime And Promotion State

The existing shared outbox dispatcher and workload consumers are the only
runtime topology. Production images run precompiled JavaScript directly with
Node; they do not require `npm`, `ts-node`, or development dependencies.
`settlement.requested` is routed to the existing Settlement workload queue. Its
consumer validates the exact durable outcome version, request, outbox event,
Outcome Certificate, and `SettlementInput` before atomically appending one
consumption record and one draw completion record.

Recovery detects current published versions with no Settlement request and
creates the missing request through the same canonical repository. It also
requeues an unconfirmed published outbox event with the same event identifier.
Duplicate deliveries return the existing consumption evidence. Conflicting or
stale evidence fails closed.

Production Outcome Authority remains disabled. Promotion additionally requires
commissioned production provider and signing custody, production rehearsal
evidence, and all readiness markers to pass. Production readiness fails when
legacy publication is enabled. There is no fallback to a legacy publisher.
Jurisdiction and certification remain optional unless a manifest requires
them.

## Innovation Backlog

The following are intentionally outside the launch-critical integration:

- advanced publication analytics;
- cross-region publication;
- regulator streaming;
- operator monitoring enhancements.
