# Phase 22.6I - Keno Game Module Reference Implementation

## Purpose

Phase 22.6I adds the first real Game Module reference implementation: a generic Keno game-family module. The module validates the SDK with real game-family rules while keeping production product configuration, official feed intake, ticket reads, and settlement integration deferred.

## Scope

The Keno module is generic. It is not a Hot Spot product implementation and it does not hardcode any state lottery product. Hot Spot remains a future product configuration that can bind to the Keno module with official or manual certified results.

Implemented capabilities:

- Keno ticket validation.
- Keno draw result validation.
- Spot hit-count evaluation.
- Bullseye evaluation when configured.
- Derived wager evaluation.
- Paytable lookup from supplied fixture/configuration payload.
- Deterministic fixtures for contract tests.
- Module manifest and configuration schema metadata.

## Default Reference Configuration

| Setting | Value |
| --- | --- |
| numberRangeMin | 1 |
| numberRangeMax | 80 |
| numbersDrawn | 20 |
| allowedSpotCounts | 1 through 10 |
| bullseyeEnabled | true |
| internalDrawGenerationEnabled | false |
| drawAuthorityMode | OFFICIAL_OR_MANUAL |
| paytableVersion | REFERENCE_PAYTABLE_V1 |

Internal draw generation remains disabled by default. Production PRNG approval is not enabled.

## Supported Wagers

- `KenoSpot`
- `KenoBullseye`
- `KenoBigSmall`
- `KenoOddEven`
- `KenoUpDown`
- `KenoDragonTiger`
- `KenoSumOverUnder`
- `KenoElement`

Derived wagers emit structured outcomes and reason codes. Payouts are read from the supplied paytable map so product-specific payout decisions remain outside the module.

## Validation

Ticket validation rejects:

- Numbers outside the configured range.
- Duplicate selections.
- Unsupported spot counts.
- Unsupported wager types.
- Bullseye usage when disabled.
- Missing or invalid derived wager parameters.

Draw validation rejects:

- Wrong drawn-number count.
- Duplicate draw numbers.
- Draw numbers outside the configured range.
- Invalid bullseye values.

## Evaluation Output

Evaluation returns:

- Outcome.
- Structured reason code.
- Hit count and matched numbers where applicable.
- Bullseye match state where applicable.
- Derived metrics for derived wagers.
- Paytable-derived payout amount.
- Module, evaluator, and paytable version metadata.

## Production Boundaries

The module is `QaCertified`, not production active. It does not read tickets from the platform database, does not publish settlement events, does not mutate financial records, and does not activate any production game.

## Validation Commands

- `dotnet build services/game-engine/GameEngine.sln`
- `dotnet test services/game-engine/GameEngine.sln --no-build`
- `npm run game-engine:keno-test`
- `npm run qa:keno-module`
- `npm run qa:all`
