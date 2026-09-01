# PR-05 Managed Runtime / Sustained Pilot Qualification

## Purpose

PR-05 qualifies the published but inactive Fast Keno and Hot Spot pilot bundle
under a controlled 30-minute concurrent workload. It exercises only the
canonical scheduler, draw, Internal CSPRNG, outcome, Math Evaluation,
Settlement, Ledger, Credit Wallet, and Ticket Completion authorities. The
campaign is qualification evidence and does not activate either product for
production traffic.

The frozen Internal CSPRNG source hash is
`2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c`.
The harness fails closed if that implementation changes.

## Workload

The required tier uses 500 concurrent player identities for 30 minutes at a
mixed target of three ticket purchases per second. Fast Keno is 80 percent of
the mix by default and Hot Spot is 20 percent. Ticket composition uses the
published product versions, all Fast Keno derived markets, Hot Spot spot
selection, Quick Pick, Bullseye, and immutable 1/5/10/20 draw plans.

Hot Spot participations whose draw is beyond the campaign window remain
scheduled exposure, not financial backlog. Every participation whose
authoritative result exists must reach Math Evaluation, SettlementInput,
Settlement, Ledger, Wallet, and Completion-source evidence before the campaign
can pass. Parent completion is expected only after all active participations
are terminal. The dedicated PR-04C suite remains the complete 20-draw,
future-cancellation, proportional-release, retry, and restart proof.

## Latency Evidence

The harness derives stage timing from durable authority records:

1. scheduled due time to scheduler detection;
2. detection to durable claim;
3. claim to provider invocation;
4. provider execution;
5. provider evidence to canonical outcome persistence;
6. certificate issuance;
7. authoritative result to Math Evaluation;
8. Math Evaluation to SettlementInput;
9. SettlementInput to authoritative Settlement;
10. Settlement to Ledger;
11. Ledger to Wallet;
12. authoritative result to Wallet.

Every stage reports sample count, p50, p95, p99, and maximum. Scheduled
due-to-authoritative-result p95 above one second blocks qualification and
identifies the largest measured component. Authoritative-result-to-Wallet p95
must remain below five seconds, with p99 no greater than 7.5 seconds for the
managed qualification environment.

## Recovery And Isolation

The campaign runs two scheduler instances and, unless explicitly disabled for
harness development, restarts one Game Engine instance, the Settlement worker,
and RabbitMQ at bounded points in the run. Durable claims, append-only attempts,
publisher confirms, consumer acknowledgements, and idempotent financial
authorities remain in force.

Qualification setup temporarily adds scoped availability and provider
activation evidence with reason `PR05_QUALIFICATION_ONLY`. Teardown appends a
`Retired` lifecycle event and closes the qualification availability effective
window while retaining the exact row referenced by accepted tickets. It removes
the temporary provider activation rows and restores both products to
`PUBLISHED / INACTIVE / UNASSIGNED`. Production Settlement activation is
never enabled.

## Current Qualification Status

PR-05 remains blocked in the current disposable Docker environment. The clean
canonical-chain diagnostic `pr05-20260827T022451Z-8417d3af` completed all 1,427
due participations and all 495 expected parent tickets with exact financial
reconciliation and zero duplicate outcomes, evaluations, settlements, Ledger
effects, Wallet effects, or Completion effects. Its measured
authoritative-result-to-Wallet p95 was `10075.31 ms`, above the required gate.

Further diagnostics identified two environment limits that prevent a credible
30-minute qualification:

- sixteen Settlement consumers exceeded PostgreSQL's 100-client ceiling;
- twelve consumers plus the two qualification Game Engine instances also
  exhausted the same ceiling under fanout, even after bounding the harness pool
  from 36 to 12 connections.

The failed campaigns remain preserved under `.qa/pr-05/`. No PostgreSQL limit
was raised and no service pool, authority, idempotency rule, or financial gate
was weakened to manufacture capacity. A valid rerun requires a managed or
disposable database connection budget sized for the real service topology,
followed by the full 30-minute campaign.

## Evidence

Each invocation writes an immutable local evidence directory beneath
`.qa/pr-05/<campaign-id>/`, including environment and workload descriptions,
resource and queue snapshots, per-tier results, stage latency distributions,
negative tests, recovery events, anomaly records, a summary, a Markdown report,
and a SHA-256 evidence manifest. Failed campaigns remain separately
identifiable and are not replaced by later runs.

Local managed-runtime evidence does not replace hosted CI, production rehearsal,
or external infrastructure capacity qualification.
