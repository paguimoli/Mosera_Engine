# Backend Freeze Authority Ownership

BF-7.1 freezes one production owner, execution path, registration, and readiness
source for every implemented business authority. Guarded comparison, rollback,
replay, diagnostics, and migration evidence are not competing mutation paths.

| Authority | Canonical owner | Execution boundary |
| --- | --- | --- |
| Scope | Platform Service | Canonical Scope Resolver |
| Hierarchy | Platform Service | Canonical Hierarchy Authority |
| Financial | Ledger Service | Canonical Financial Authority entrypoints |
| Funding Instrument | Wallet Service | Funding Instrument Authority |
| Compensation | Commission Service | Compensation Authority |
| Draw | Game Engine | Immutable Draw Authority |
| Draw Orchestrator | Game Engine | Canonical Draw Orchestrator |
| Outcome Provider | Game Engine | Canonical Outcome Provider Authority |
| Internal CSPRNG Provider | Game Engine | Internal CSPRNG Provider |
| Official Results Provider | Game Engine | Official Results Provider |
| Manual Certified Provider | Game Engine | Manual Certified Provider |
| Outcome | Game Engine | Canonical Outcome Authority |
| Outcome Lifecycle | Game Engine | Canonical Outcome Lifecycle Authority |
| Game Engine Production Activation | Game Engine | Production Activation Authority |
| Ticket Acceptance | Ticket Service | `ticket_authority.accept_ticket` |
| Effective Availability | Ticket Service | `ticket_authority.resolve_effective_availability` |
| Ticket Liability | Ticket Service | `ticket_authority.evaluate_liability` |
| Ticket Lifecycle | Ticket Service | Typed Ticket Lifecycle Authority |
| Completion | Ticket Service | Financial Completion Authority |
| Ticket Exception | Ticket Service | Ticket Exception Authority |
| Operational Governance | Operational Service | Operational Governance Authority |
| Operational Security | Operational Service | Operational Security Authority |
| Operational Change | Operational Service | Operational Change Authority |

The machine-readable ownership registry in
`src/architecture/authorities/authority-consolidation.ts` records the exact
registration, execution, and readiness source for each row. Application
readiness reports `registered`, `ready`, `healthy`, `productionCapable`,
`governed`, and `auditable` once per authority.

## Retained Compatibility

- Phase 22.6 Game Engine registry and scheduler endpoints remain read-only
  diagnostics. Their durable repository registrations and background writes are
  retired; canonical draw publication is the only production mutation path.
- Client-only Ticket and hierarchy presentation state remains isolated from API,
  worker, and authority execution paths.
- Replay, shadow comparison, dry-run, and promotion evidence validate canonical
  records but do not create a second authoritative result.
- Historical migration contracts remain in place so existing immutable records
  stay readable. Later migrations that add orchestration, lifecycle, or recovery
  evidence extend those records rather than duplicate their authority.

## Rules

- Routes, workers, hosted services, and consumers call canonical authority
  entrypoints, never alternate persistence adapters.
- Client-supplied scope and funding choices are identifiers to validate, never
  authority inputs.
- Compatibility code may project or verify canonical state but cannot mutate it.
- Every production authority has one declared owner, execution identity,
  registration identity, and readiness source.
- Adding a second registration or restoring a legacy draw repository to Game
  Engine dependency injection fails cross-authority QA.

`npm run qa:cross-authority-integrity` is the BF-7.1 ownership gate.
`npm run qa:backend-authority-consolidation` remains the routing regression gate.
