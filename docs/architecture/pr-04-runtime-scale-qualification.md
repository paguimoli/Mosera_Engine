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
