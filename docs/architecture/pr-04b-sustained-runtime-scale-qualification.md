# PR-04B Sustained Runtime Scale Qualification

## Purpose

PR-04B qualifies the local release-candidate runtime under sustained mixed Fast
Keno and Hot Spot traffic. It is evidence generation, not production
activation. The canonical baseline is
`8a474adcceda180377f9889ae269835d1b6aac95`, and the frozen CSPRNG source hash is
`2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c`.

The runner uses the existing authorities only:

1. `ticket_authority.accept_ticket` for scope, availability, liability,
   funding, reservation, and ticket acceptance.
2. `DurableSchedulerRuntime` for schedule materialization and claims.
3. `CanonicalDrawExecutionAuthority` and the manifest-bound
   `INTERNAL_CSPRNG` provider for outcomes.
4. `SchedulerOutcomeCompletionFanout` for Math Evaluation, SettlementInput, and
   settlement requests.
5. Settlement, Ledger, Credit Wallet, and Completion authorities for financial
   completion.

No direct wallet mutation or alternate outcome path exists in the harness.

Migration 136 repairs the scheduler sequence bootstrap discovered by the first
preserved PR-04B smoke run: historical authoritative draws can exist before a
sequence row. The allocator now starts strictly after the maximum retained
public draw number and remains monotonic across restart.

Migration 137 closes the fail-closed acceptance defect found by the next
preserved smoke run. The sole ticket authority now reads the exact immutable
active product version and enforces Fast Keno wager count, minimum and
market-specific maximum stakes, plus Hot Spot play count, stake range, spot
count, number range, and uniqueness before reservation.

Migration 138 preserves the same pilot-product enforcement while restoring
the existing non-pilot ticket lifecycle fixtures. Non-pilot products retain
their exact immutable version binding without inheriting pilot-only lifecycle
requirements.

## Current Qualification Disposition

Campaign `pr04b-20260826T153932Z-5b807dc6` completed the short correctness
preflight through four tickets, twelve ticket items, two real CSPRNG outcomes,
twelve Math Evaluation Certificates, twelve SettlementInput records, twelve
settlements, and four terminal completions. It then failed closed at Hot Spot
multi-draw binding. The selected five-draw purchase had only a one-draw
authoritative reservation, while the existing database guard requires the full
upfront reservation. Existing multi-draw bindings are persisted but are not
consumed by the canonical ticket-to-completion fanout to create one immutable
execution per bound draw. Increasing the first ticket item's stake would
misstate first-draw evaluation economics, so the harness does not bypass the
guardrail.

The completed one-draw chains recorded zero duplicate outcomes, financial
effects, settlements, or completion sources; zero cross-player contamination;
and zero provider fallback. Result-to-wallet p95 was 4,903.10 ms in this short
preflight. These observations are correctness evidence only and do not support
a sustained performance or capacity claim.

This is a HIGH correctness blocker. No baseline, pilot, elevated, stress, or
capacity claim may be made until canonical multi-draw purchase acceptance,
upfront reservation, per-draw execution, settlement, completion, retry, and
recovery are connected end to end. The failed campaign and earlier smoke
campaigns remain independently retained under `.qa/pr-04b/`.

## Qualification Isolation

The runner requires `PR04B_QUALIFICATION_APPROVED=true`, a non-production
deployment, PostgreSQL whose database name contains `local`, `test`, `qa`, or
`ci`, and the exact baseline commit. It temporarily exposes the already
published pilot product versions to the scheduler and inserts qualification-only
provider activation evidence. A `finally` block stops qualification Game Engine
instances, removes qualification availability and provider activation rows, and
restores both products to `PUBLISHED / INACTIVE / UNASSIGNED` with no active
version. Production Settlement activation is never enabled.

Synthetic accounts and all ticket, outcome, certificate, financial, completion,
and anomaly evidence remain durable. They are qualification evidence, not
catalog activation.

## Campaigns

The default run is sequential:

| Tier | Players | Duration | Purpose |
| --- | ---: | ---: | --- |
| Baseline | 100 | 30 minutes | Stable cadence baseline |
| Pilot | 500 | 30 minutes | Pilot capacity |
| Elevated | 2,000 | 60 minutes | Required elevated qualification |
| Stress | 5,000 | 10 minutes | Exploratory saturation characterization |

Durations, issue rates, product mix, and stress population are configurable for
smoke diagnostics. A shortened run cannot claim the corresponding sustained
capacity tier. Fast Keno and Hot Spot use their immutable production schedules
and economic configuration.

The player model uses weighted light, active, high-activity, and burst cohorts.
Ticket issue timing contains jitter and pre-cutoff bursts. Fast Keno exercises
all 19 approved markets. Hot Spot exercises 1-10 spots, manual and canonical
Quick Pick evidence, Bullseye, and approved multi-draw counts.

## Evidence

Each invocation creates `.qa/pr-04b/<campaign-id>/` with:

- `environment.json`
- `workload.json`
- `campaign-<tier>.json`
- `metrics.jsonl`
- `failure-injection.json`
- `negative-tests.json`
- `anomaly-register.json`
- `qualification-summary.json`
- `evidence-manifest.json`
- `qualification-report.md`
- Game Engine instance logs

The manifest hashes every material evidence file. Failed and blocked campaigns
are retained and are never overwritten. Large transient logs remain outside
Git under `.qa/`.

## Pass Rules

The highest claimed tier must complete its full required duration with zero
duplicate outcomes, duplicate financial effects, cross-player contamination,
missed draws, schedule drift, provider fallback, or silent post-cutoff
acceptance. Backlog must clear rather than grow, and result-to-wallet p95 must
remain below five seconds. Tail latency and every failure/recovery event are
reported without averaging them away.

Pilot products and production authority activation remain disabled after every
run, whether it passes, fails, is cancelled, or the runtime throws.
