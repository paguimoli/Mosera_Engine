# Backend Freeze Canonical Hierarchy Authority

BF-2.2 establishes
`src/domains/hierarchy/canonical-hierarchy-authority.ts` as the single
production hierarchy decision implementation.

## Hierarchies

The authority resolves and validates the approved commercial hierarchy:

`Platform -> Organization -> Tenant -> Brand -> Market -> Website`

It also resolves and validates the approved governed-account hierarchy:

`Super Master -> Master Agent -> Agent -> Player`

Existing support for nested Master Agent records is preserved for compatibility.
No new hierarchy type, numbering model, membership model, or scope model is
introduced.

## Responsibilities

The authority owns:

- exact Platform ancestry resolution;
- account ancestor and descendant traversal;
- parent type and active-parent validation;
- cycle prevention;
- cross-Tenant, cross-Brand, and cross-Market movement prevention;
- account type-change/downline validation;
- ancestor membership validation;
- Platform activation and retirement dependency validation;
- hierarchy readiness evidence.

PostgreSQL triggers from migrations `081` and `082` remain the final
transactional persistence guardrails. They enforce the same canonical
relationships and append immutable account-governance evidence. They are not
an alternate application authority.

## Callers

- Account creation, reassignment, type changes, disable checks, and child
  queries delegate to the authority.
- The Canonical Scope Resolver consumes the authority's durable account
  ancestor result.
- Platform Management scope resolution and lifecycle parent checks delegate to
  the authority.
- Ticket, financial, commission, settlement, and worker paths consume the
  canonical account and Platform identifiers persisted by these authorities;
  they do not traverse or mutate hierarchy independently.

The legacy dashboard retains pure in-memory tree helpers for presentation and
form feedback only. Those helpers cannot persist, authorize, or establish
production hierarchy.
