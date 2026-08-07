# RC-1.3 Representative Load Qualification

## Authority and purpose

`npm run qa:rc-load-qualification` is the canonical disposable-runtime load qualification for RC-1.3. It drives authenticated ticket traffic through the existing Next.js API and its canonical SQL authorities, then invokes the existing Outcome-to-Settlement and recovery QA contracts. It does not provide a production execution path.

Evidence is written to `.qa/rc-1.3/summary.json` and `.qa/rc-1.3/summary.md`. The JSON record is authoritative for automated review; the Markdown record is the human summary.

## Conservative launch profile

The default profile is deliberately modest for the single-host RC runtime:

- 2 steady ticket acceptances per second for 60 minutes.
- 20 concurrent requests around draw close.
- Equal CREDIT and FREE_PLAY traffic.
- Outcome bursts covering INTERNAL_CSPRNG, OFFICIAL_RESULTS, and MANUAL_CERTIFIED.
- Concurrent authenticated operator reads, Outbox dispatch, and worker processing.
- Capacity steps of 5, 10, 20, and 40 concurrent ticket requests.
- A 2 second p95 and 1 percent terminal-error stop boundary during capacity exploration.

These are launch qualification assumptions, not contractual production capacity. Production-like staging must repeat the same harness with measured traffic forecasts and provider infrastructure sizing.

## Configuration

The harness accepts `RC_LOAD_SOAK_MINUTES`, `RC_LOAD_STEADY_TPS`, `RC_LOAD_BURST_CONCURRENCY`, `RC_LOAD_RUN_ID`, `RC_LOAD_EVIDENCE_DIR`, `APP_URL`, and `DATABASE_URL`. Reducing soak time is intended only for harness development and cannot establish sustained-stability evidence.

The harness requires the disposable local Compose runtime, canonical migrations, the local Auth Service QA identity, and RabbitMQ management diagnostics. It never uses Supabase and does not disable authority, readiness, scope, availability, liability, funding, or idempotency checks.

## Interpretation

Qualification passes only when all ten stages and financial reconciliation pass. HTTP success alone is insufficient: the report also checks duplicate tickets/reservations, unresolved DLQ state, ledger integrity, wallet reconciliation, instruction reconciliation, readiness, worker evidence, queue state, and dependency recovery.

The current harness deliberately fails the final RC qualification gate until three pieces of evidence exist in one run: a minimum 60-minute mixed-workload soak, a continuous ticket-to-compensation evidence chain for every launch provider/funding combination, and dependency restart testing while ticket traffic remains active. Existing focused QA proves the provider handoff, both funding paths, and dependency recovery independently; combining independent proofs is not treated as continuous-chain load evidence.

The machine-readable `qualificationGates` object distinguishes stage mechanics from final RC evidence. A development run with `RC_LOAD_SOAK_MINUTES` below 60 can validate harness behavior, but it must report `RC_LOAD_BLOCKED`.

The first limiting capacity step must be treated as evidence for staging sizing, not as permission to weaken validation or consistency.
