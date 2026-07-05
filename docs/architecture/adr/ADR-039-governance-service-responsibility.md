# ADR-039 - Governance Service Responsibility

## Status

Accepted

## Context

Production authority requires controlled approvals, version promotion,
jurisdiction activation, emergency disable, and evidence capture. These
responsibilities must not be buried inside outcome, math, settlement, or ledger
execution paths.

## Decision

Governance Service is the authority control plane.

It owns:

- version approvals;
- promotion workflows;
- dual approval;
- certification state;
- manifest publication;
- jurisdiction activation;
- emergency disable;
- authority kill switches;
- production readiness evidence;
- supersession approval;
- correction approval;
- replay approval;
- resettlement approval;
- break-glass governance;
- Governance Approval Certificates.

Governance Service does not execute outcomes, calculate math, settle tickets,
or post ledger entries.

## Rationale

Governance is a control plane. Keeping it separate preserves separation of
duties and gives operators and auditors a single place to inspect why a
production artifact was allowed to run.

## Consequences

- Production activation requires a signed Governance Approval Certificate.
- Emergency disable applies prospectively unless a specific correction workflow
  states otherwise.
- Dual approval must be enforced for production activation, correction,
  supersession, replay, and resettlement.
- Governance records must be immutable and exportable.
