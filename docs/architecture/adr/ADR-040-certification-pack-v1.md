# ADR-040 - Certification Pack v1

## Status

Accepted

## Context

Mosera needs repeatable certification evidence for GLI, BMM, eCOGRA,
independent auditors, regulators, operators, partners, and internal review.

## Decision

Certification Pack v1 is a signed evidence package that binds the approved
versions and validation results for a product or authority capability.

Required contents:

- Game Manifest Certificate;
- Governance Approval Certificate;
- Outcome Strategy Certificate;
- RNG Provider Certificate;
- Math Model Certificate;
- paytable and RTP evidence;
- statistical validation reports;
- simulation reports;
- deterministic replay fixtures;
- source/build metadata;
- container image digests;
- SBOM reference;
- signing key metadata;
- hash chain root;
- jurisdiction profile;
- operator approvals;
- known limitations;
- evidence index.

## Versioning

Certification packs are immutable. Any change to evidence, manifest, outcome
strategy, RNG provider, math model, paytable, jurisdiction profile, or approval
state creates a new pack version.

## Export Format

Certification Pack v1 must support:

- canonical JSON for machine validation;
- signed PDF for human/regulator review;
- archive format containing manifest, hashes, signatures, fixtures, reports,
  and evidence index.

## Consequences

- Production activation fails closed without a required certification pack.
- Replay packages must reference certification pack versions.
- External lab submission can be automated later without changing authority
  contracts.
