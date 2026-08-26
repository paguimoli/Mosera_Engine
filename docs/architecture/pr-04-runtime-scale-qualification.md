# PR-04 Runtime Scale Qualification

## Purpose

PR-04 qualifies the approved Fast Keno and Hot Spot products under concurrent,
mixed-system load. It is not a production activation mechanism. Capacity may be
claimed only when the same campaign exercises canonical ticket acceptance,
Internal CSPRNG outcome generation, certification, typed Math evaluation,
SettlementInput handoff, Settlement, Ledger, Wallet, and Completion Authority.

`npm run qa:pr04-runtime-scale-qualification` is the fail-closed preflight. Each
invocation creates a unique evidence directory under `.qa/pr-04`. Existing
evidence is never overwritten. The manifest hashes the environment snapshot,
anomaly register, and machine/human summaries.

## Current Disposition

The accepted blocked campaign is
`pr04-20260825T000252Z-3f075a8a`. Sustained baseline, pilot, elevated,
stress, and failure-injection tiers were intentionally not executed, and no
performance or capacity claim was made.

The preserved HIGH anomaly,
`FULL_CHAIN_CONTROL_FIXTURE_INCOMPATIBLE`, records that the canonical CSPRNG
full-chain fixture had no accepted ticket whose immutable paytable version
matched an outcome-capable product version. The blocked result remains
`PR_04_RUNTIME_SCALE_QUALIFICATION_BLOCKED`; it is not evidence of a CSPRNG
regression.

The PR-03 scheduler correctly owns durable materialization, draw claims, CSPRNG
provider invocation, and recovery. Its canonical execution command intentionally
passes no Outcome Certificate or SettlementInput. Canonical Draw Execution then
stops at `AwaitingCertification`. There is no production scheduler step that
fans the certified outcome into typed Math evaluation and one immutable
SettlementInput per accepted ticket item.

The existing one-ticket CSPRNG full-chain QA is useful component evidence, but it
constructs qualification-specific certificate and prize facts. It is not a
natural-outcome, many-player scheduler load path and cannot substitute for
PR-04 evidence.

Therefore the preflight must block sustained campaigns until the canonical
certificate, Math evaluation, and per-ticket settlement fanout are available in
an isolated qualification mode. Running acceptance-only traffic would produce
misleading capacity evidence and is prohibited.

### PR-04A Closure

PR-04A closes the scheduler-driven pilot-product crossover in explicit,
non-production qualification mode. One scheduler claim now produces immutable
Internal CSPRNG evidence, a verified RSA-3072 Outcome Certificate, bounded typed
Math evaluation for every accepted ticket item, exact SettlementInput lineage,
and one canonical settlement request per item. The existing Settlement,
Ledger, Credit Wallet, and Completion authorities perform all financial work.

The qualification campaign covers multiple funded players and opposing wagers
for Fast Keno, the combined payout cap, Hot Spot manual and Quick Pick entries,
Bullseye on/off, and immutable five-draw binding. Every ticket reaches
`REBATE_ELIGIBLE`, every reservation reaches `CAPTURED` with zero remaining
exposure, and duplicate Settlement and Completion effects remain zero.

Fast Keno's configurable `$10,000` ceiling is applied once after aggregating all
winning and push/refund returns for one ticket and draw. It is not applied to
each evaluation item. The final semantic audit corrected losing derived wagers
that had retained paytable multipliers; that defect made an earlier run report
eight capped items. Focused and full-chain evidence now reports one capped item
for the cap fixture, with retries reusing the same immutable result. Hot Spot is
intentionally different: its `$50,000` ceiling applies independently to each
play after combining the base and Bullseye supplemental return, so a multi-play
ticket may exceed `$50,000` in total.

Recovery evidence is injected after certificate issuance, after Math, after
SettlementInput persistence, and after partial page completion. Concurrent
scheduler instances produce one claim and one authoritative result. Completed
item evidence is reused on every retry.

Qualification fanout is disabled by default, requires an explicit qualification
marker and ephemeral signing key, and rejects `DEPLOYMENT_ENVIRONMENT=production`.
Production Settlement activation remains disabled. Fast Keno and Hot Spot are
restored to `PUBLISHED / INACTIVE / UNASSIGNED` during teardown.

Migrations 122-135 add the fanout and subsequent recovery/lineage corrections
without rewriting applied migrations. The original HIGH paytable-lineage
anomaly remains preserved historically; the repaired fixture now uses exact
accepted-ticket lineage, and a mismatched paytable is covered by negative QA.

The preflight disposition is now `READY_FOR_SUSTAINED_PR_04`. This is readiness
to begin a separate load campaign, not a capacity result. Baseline, pilot,
elevated, stress, and sustained load tiers remain unexecuted in PR-04A.

## Required Closure Before Campaigns

1. Resume each scheduler-generated result through governed Outcome Certificate
   issuance without changing the selected provider or outcome.
2. Resolve every accepted ticket item against its immutable manifest, Math
   Model, Paytable, and evaluator versions.
3. Persist typed PrizeFacts, Math Evaluation Certificates, and SettlementInputs
   through existing durable repositories.
4. Emit one idempotent settlement request per applicable ticket item and retain
   result-to-wallet KPI timestamps.
5. Provide an explicit, disposable qualification activation that tears down to
   published/inactive/unassigned catalog state.
6. Repair the full-chain control fixture so it selects or creates an accepted
   ticket bound to an outcome-capable immutable product version.

These are orchestration closure requirements. They do not justify a second
Outcome, Math, Settlement, Ledger, Wallet, or Completion authority.

## Capacity Policy

No baseline, pilot, elevated, or stress tier is claimed until the full canonical
chain passes continuously. Failed and blocked campaigns remain identifiable;
reruns must use new campaign identities and must not replace earlier evidence.
