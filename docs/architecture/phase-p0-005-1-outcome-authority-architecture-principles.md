# P0-005.1 - Outcome Authority ADRs and Architecture Principles

## Scope

P0-005.1 freezes the permanent architecture records for Mosera Outcome
Authority, Math Authority, Certification, Governance, Simulation, and the
cross-authority certificate chain.

This phase is documentation only. It does not implement code, migrations,
Docker changes, runtime wiring, or production activation.

## Architecture Records

The following ADRs define the stable architecture baseline:

- `ADR-034-outcome-authority-graph.md`
- `ADR-035-authority-certificate-chain.md`
- `ADR-036-game-manifest-v1.md`
- `ADR-037-outcome-authority-principles.md`
- `ADR-038-math-authority-rtp-governance.md`
- `ADR-039-governance-service-responsibility.md`
- `ADR-040-certification-pack-v1.md`
- `ADR-041-outcome-dsl-v1.md`
- `ADR-042-math-dsl-v1-constraints.md`
- `ADR-043-simulation-service-separation.md`
- `ADR-044-outcome-authority-architecture-principles-v1.md`

## Frozen Principles

- Outcome Authority never knows money.
- Math Authority never generates randomness.
- RTP is never controlled by RNG.
- Settlement never changes outcomes.
- Ledger is immutable financial truth.
- Every authority produces signed and hash-linked evidence.
- Production artifacts are immutable and versioned.
- No production placeholders are allowed in authority paths.
- Simulation can never be production authority.

## Authority Graph

The production authority graph is:

```text
Governance Authority
  -> Game Definition Authority
  -> Outcome Authority
  -> Math Authority
  -> Settlement Authority
  -> Ledger Authority
```

This is not a strict runtime call chain. Governance signs approvals across all
authorities. Each authority owns its own evidence, versioning, lifecycle, and
failure behavior. Cross-authority communication must use immutable contracts,
signed certificates, durable events, or governed command APIs.

## Implementation Boundary

Short term, the existing Game Engine service may host these bounded contexts
while implementation is still consolidating. Long term, the boundaries should
support independent services:

- Governance Service
- Game Definition Service
- Outcome Authority Service
- Math Authority Service
- Certification Service
- Simulation Service

Settlement Service and Ledger Service already remain outside outcome and math
authority.

## Non-Goals

- No production RNG implementation.
- No Outcome DSL parser.
- No Math DSL parser.
- No schema migration.
- No certificate persistence.
- No service decomposition.
- No production activation.

## Next Phase

P0-005.2 should define the immutable outcome primitive/domain model and Outcome
Certificate schema before any production RNG implementation is attempted.
