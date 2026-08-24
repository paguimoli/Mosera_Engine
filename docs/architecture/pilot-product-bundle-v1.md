# Pilot Product Bundle v1

## Status

PR-02 publishes two immutable global product versions:

| Product | Engine | Publication | Activation | Assignment |
| --- | --- | --- | --- | --- |
| `FAST_KENO_V1` | `KENO_GENERIC@1.0.0-pilot` | `PUBLISHED` | `INACTIVE` | `UNASSIGNED` |
| `HOT_SPOT_V1` | `KENO_GENERIC@1.0.0-pilot` | `PUBLISHED` | `INACTIVE` | `UNASSIGNED` |

Publication does not make either product playable. Neither product has an active
Game Definition pointer, platform availability row, tenant assignment, channel
assignment, generated draw, or enabled scheduler runtime. Product activation is
a separate governed operation.

## Immutable Lineage

Each Game Definition version binds the exact:

- Game Manifest and content hash;
- Math Model and content hash;
- Paytable and content hash;
- published draw schedule version and hash;
- Outcome Provider version and provider configuration version/hash;
- settlement policy version;
- limits, caps, wager capabilities, schedule semantics, and product state.

Published versions reject update and delete. Economics, provider, schedule, or
cap changes require a superseding version. Existing canonical tickets already
retain exact Game Definition, Manifest, Paytable, draw/execution manifest,
provider configuration, and settlement lineage; no latest-version lookup is
introduced.

## Fast Keno v1

Fast Keno is derived-only. Spot wagers and Quick Pick are disabled. The immutable
configuration contains all nineteen approved markets, decimal odds, tie rules,
minimum and odds-specific maximum stakes, the 20-wager limit, opposing-wager
permission, and the USD 10,000 combined ticket payout cap.

The Keno Math evaluator derives markets from one certified 20-of-80 outcome:

- Big/Small and Odd/Even use the total sum;
- Dragon/Tiger compares the second-to-last and last sum digits;
- Up/Down counts numbers in 1-40 and 41-80;
- parlays intersect Big/Small with sum parity;
- Gold, Wood, Water, Fire, and Earth use the approved sum bands.

Dragon/Tiger pushes on equal compared digits. Up/Down loses on a 10/10 split;
`UD_TIE` is a separate winning selection.

The schedule is an immutable 25-second, midnight-anchored
`America/New_York` definition with a hard five-second cutoff and independent
public draw sequence. It is persisted as schedule configuration only; PR-03
owns durable scheduler execution.

## Hot Spot v1

Hot Spot uses the Keno engine and Keno Math evaluator. The legacy `HOT_SPOT`
skeleton remains non-production-resolvable and is not referenced by this
product.

The product supports one through ten spots, manual or persisted Quick Pick,
one/five/ten/twenty valid draws, and an optional attached Bullseye add-on.
Bullseye is not standalone and is not player selected. Its stake equals the base
stake. The designated Bullseye must be one of the certified twenty drawn
numbers and uses a separate `HOT_SPOT_BULLSEYE_V1` randomness domain.

The Keno Math evaluator resolves partial hit rows. For a Bullseye play it applies
the source table's combined payout exactly once, scales from the base $1 unit,
and caps each play at USD 50,000. Prize facts expose base, supplemental, and
combined components.

The schedule is an immutable four-minute `America/New_York` definition from
06:00 through the 02:00 draw, with a hard fifteen-second cutoff. Multi-draw skips
the 02:00-06:00 closed window and resumes at the next valid draw.

## Paytable Evidence

`MOSERA_HOT_SPOT_PAYTABLE_V1` is encoded from the supplied standard,
non-promotional California Hot Spot and Bulls-Eye source package.

- Normalized source JSON SHA-256:
  `8dc01631d3dc22ef7941fa7cb95253d06f9aee038853a62458341b46acdeeeaa`
- Source ZIP SHA-256:
  `3843d61146af35100872178b5100a6b527e4f88add112398d81bd0b0edf8fe62`
- Screenshots captured: 2026-08-21
- Source effective date: not stated
- Approval: `INTERNAL_APPROVED`
- External review: pending

The normalized source and source manifest are retained under
`docs/evidence/pilot-products`. The ZIP remains external because it contains
binary source captures; its digest is retained in immutable metadata.

## Governance and Operations

Only a Super Admin may publish, globally activate/suspend, assign, or alter
RTP-affecting versions. Future tenant, brand, and website/channel availability
continues through the existing permission-plus-hierarchy scoped Platform
Availability Authority. Higher-level suspension remains fail-closed.

Canonical ticket acceptance remains responsible for atomic full reservation.
Players cannot cancel accepted wagers. Governed cancellation is allowed only
before outcome generation; post-outcome changes use correction, reversal, and
resettlement authorities. Suspension stops new acceptance and does not silently
invalidate funded tickets.

## Runtime Read Model

Future UI/API read models may expose only non-sensitive product configuration:
product/version, public draw number and state, countdown/cutoff, enabled wagers,
odds, limits, total stake, caps, Quick Pick/Bullseye/multi-draw capabilities,
recent results, roadmap data, ticket reference/status, pending settlement, and
prize components. The frontend never decides availability, cutoff, funding,
outcome, payout, or settlement.

## Carry-Forward

PR-06 must measure authoritative-result-to-wallet-availability latency at
p50/p95/p99/max, unsettled count, and backlog by draw. Target is one to two
seconds; five seconds is the operational upper objective. Fast Keno must sustain
the 25-second cadence without backlog growth.

Pre-pilot requirements: durable scheduler runtime (PR-03), authoritative Hot
Spot Quick Pick runtime execution and persisted ticket binding, authoritative
Hot Spot Bullseye runtime execution and immutable draw evidence, product
assignment/activation, settlement KPI instrumentation and qualification, and
player UI.

Deferred beyond the pilot: external certification/WORM storage, Retail POS, and
external wagering API.
