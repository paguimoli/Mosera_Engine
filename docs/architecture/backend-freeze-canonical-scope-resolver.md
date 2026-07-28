# Backend Freeze Canonical Scope Resolver

BF-2.1 establishes
`src/domains/scope/canonical-scope-resolver.ts` as the single production scope
decision implementation.

## Inputs

The resolver combines:

- the authenticated Auth Service identity, session, roles, permissions, and
  durable scope claims;
- authoritative Platform Management relationship snapshots;
- authoritative Account hierarchy records;
- validated Ticket or financial resource records.

Request identifiers select a resource for lookup. They never establish its
Tenant, Organization, Brand, Market, Website, Account hierarchy, operating
mode, or funding eligibility.

## Derived Scope

The result contains Platform, Organization, Tenant, Brand, Market, Website,
Account, Player, Agent, Master Agent, hierarchy, roles, permissions, operating
mode, and eligible funding instruments where the authoritative target provides
them.

Scope matching is fail closed. Global access requires `system.admin` or an
explicit `GLOBAL:platform`/`GLOBAL:*` claim. Otherwise the authenticated claim
must match an authoritative target relationship.

## Boundaries

- Auth middleware delegates permission decisions to the resolver.
- Account, Ticket, and Platform Management guards delegate scope matching to
  the resolver.
- Account resource operations load the governed Account and its ancestor chain
  before authorizing.
- Financial HTTP routes validate account identifiers against resolved scope.
- .NET financial and Settlement services accept only authenticated internal
  service calls; their canonical SQL requests validate persisted resource
  relationships and do not derive user scope from payload claims.
- Workers consume canonical identifiers and call authority entrypoints. They do
  not establish user scope.

Public request contracts remain compatible. Client-supplied identifiers that
do not match the authenticated scope are rejected.
