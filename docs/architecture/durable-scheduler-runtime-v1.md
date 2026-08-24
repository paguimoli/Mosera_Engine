# Durable Scheduler Runtime v1

## Authority

`DurableDrawSchedulerHostedService` is the single production scheduler owner inside the .NET Game Engine. It reads immutable published product and schedule versions, while `DurableSchedulerRuntime` performs bounded materialization, lifecycle advancement, recovery classification, and canonical execution claims. The prior in-memory scheduler remains a non-production test adapter only.

The scheduler never generates an outcome or performs settlement itself. Its only execution adapter invokes `CanonicalDrawExecutionAuthority`, which preserves the manifest-bound Outcome Provider, canonical Outcome Authority, Settlement, Ledger, Wallet, and Completion authorities. There is no fallback provider.

## Time Model

All authoritative draw instants are derived from immutable schedule configuration and persisted in UTC. Business-time interpretation uses the IANA `America/New_York` zone. Internal draw identity binds product version, schedule version, and the UTC instant; public draw numbers are independent monotonic per-product sequences and are never sole authority identifiers.

Fast Keno is anchored at local midnight and advances at exact 25-second UTC intervals within each local schedule day. The bounded materialization horizon is 15 minutes by default. Hot Spot starts at 06:00 local, advances every four minutes through the configured 02:00 boundary, omits the closed 02:00-06:00 window, and uses a 24-hour default horizon. Horizons are bounded by validated environment configuration.

Spring-forward and fall-back are resolved through system IANA data. UTC identity prevents repeated wall-clock labels from colliding. A nonexistent Hot Spot closing boundary is advanced to the first valid local instant and treated as exclusive; ambiguous authoritative boundaries fail closed. Host clocks must be synchronized by the deployment platform through NTP or an equivalent service. Scheduler lag is exposed as evidence; the Game Engine does not implement a second clock authority.

## Activation And Cutoff

Only an exact product version that is `PUBLISHED`, `ACTIVE`, `ASSIGNED`, current for its product, and within its effective period may materialize. This is checked in both application selection and the PostgreSQL materialization transaction. PR-03 leaves `FAST_KENO_V1` and `HOT_SPOT_V1` `PUBLISHED / INACTIVE / UNASSIGNED`, so registration of the hosted service cannot activate them.

Cutoff instants are persisted server-side: five seconds before Fast Keno and fifteen seconds before Hot Spot. Existing canonical ticket acceptance remains authoritative for accepting-state, draw identity, immutable version lineage, reservation, and cutoff enforcement. No scheduler code retargets a stale wager request.

## Persistence And Concurrency

Migration 121 adds the durable draw projection, per-product sequences, immutable lifecycle events and execution attempts, bounded execution leases, and Hot Spot Quick Pick, Bullseye, and multi-draw evidence. Materialization and execution claims use PostgreSQL advisory locks. Logical draw and public-number uniqueness constraints make concurrent scheduler losers observe existing state. Leases are bounded and retry attempts are append-only.

Execution resumes from persisted state after restart. Results already held by canonical authorities are reused; the scheduler never regenerates them. A missed draw beyond the configured recovery window becomes `RecoveryRequired` when funded accepted wagers exist. Without funded wagers it becomes `SkippedNoWagers`; historical outcomes are not fabricated to fill a gap. Future scheduled instants never move.

## Hot Spot Runtime

Quick Pick uses the qualified entropy and HMAC-DRBG interfaces with purpose `HOT_SPOT_QUICK_PICK_V1`. It selects unique numbers from 1-80, persists the selection by idempotency identity, and reuses it across retries and multi-draw bindings. It is player-selection evidence, not outcome evidence.

Bullseye uses a separate purpose, `HOT_SPOT_BULLSEYE_V1`, and selects exactly one member of the certified 20-number Hot Spot result. Evidence is immutable and binds draw, execution manifest, primary result hash, and provider configuration hash. It has no standalone outcome path.

Multi-draw accepts only 1, 5, 10, or 20 draws. It binds the exact next valid scheduled sequence, persists every canonical draw ID and public number, reuses one Quick Pick selection when present, and records the full upfront reservation amount. Existing Ticket Exception Authority remains responsible for governed cancellation of undrawn future plays.

## Operations And Limits

The read-only scheduler status endpoint reports persistence and locking readiness, materialized/accepting/due/recovery/unsettled counts, scheduler lag, and oldest unsettled age. Outcome, settlement-request, and wallet-availability timestamps feed durable KPI views for later p50/p95/p99/max qualification. PR-03 does not claim the 1-2 second target or five-second maximum; representative-load qualification remains PR-06.

Production scheduler execution and the hosted polling loop are independently disabled by default. No production tenant assignment, product activation, provider activation, or wagering is enabled by this package.

## Pre-Pilot Carry-Forward

PR-04 must perform realistic runtime, concurrency, and load qualification. That qualification must include sustained Fast Keno 25-second cadence; mixed Fast Keno and Hot Spot workload; representative player/account and wager distributions; real CSPRNG result distribution; and the complete outcome-to-settlement-to-ledger-to-wallet-to-completion chain.

The qualification evidence must report p50, p95, p99, and maximum result-to-wallet latency against the 1-2 second target and five-second super-max objective. It must also report settlement backlog by draw, RabbitMQ/worker/database backpressure, duplicate financial effects, and missed or late draws. Duplicate-effect count must remain zero, and missed/late draw count must remain zero under the supported load envelope.

Managed staging/environment qualification and player UI remain pre-pilot requirements. PR-03 does not implement or satisfy them.
