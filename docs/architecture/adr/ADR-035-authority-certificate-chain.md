# ADR-035 - Authority Certificate Chain

## Status

Accepted

## Context

Gaming platforms must prove what was approved, what outcome was generated, what
math model was used, what settlement was produced, and what financial effect was
posted. Audit evidence must be independent, replayable, hash-linked, and
exportable for regulators, laboratories, operators, partners, and incident
review.

## Decision

Mosera uses this certificate chain:

```text
Governance Approval Certificate
  -> Game Manifest Certificate
  -> Outcome Strategy Certificate
  -> RNG Provider Certificate
  -> Outcome Certificate
  -> Math Model Certificate
  -> Math Evaluation Certificate
  -> Settlement Certificate
  -> Financial Certificate
  -> Audit Export Certificate
```

Every certificate must include:

- certificate id;
- authority id;
- subject id and version;
- canonical payload hash;
- prior certificate references;
- hash algorithm version;
- signing algorithm version;
- signing key id;
- issued-at timestamp;
- jurisdiction/profile when applicable;
- lifecycle state;
- supersession or revocation pointer when applicable.

## Rationale

Certificate chains make authority boundaries visible. They allow historic
tickets to prove the exact game manifest, outcome strategy, RNG provider, math
model, settlement result, and financial effect used at the time of processing.

## Consequences

- Governance approvals become signed evidence, not mutable metadata.
- Outcome, math, settlement, and ledger evidence can be audited independently.
- Corrected outcomes or resettlements must create superseding certificates.
- Audit exports must reference certificate roots instead of loose records.
- Production activation must fail closed if any required certificate is absent.
