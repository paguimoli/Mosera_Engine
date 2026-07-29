# Backend Freeze Authority Ownership

BF-0.1 freezes one production mutation boundary for each core business
authority. Guarded service promotion, comparison, rollback, and shadow evidence
remain available, but they are not parallel production authorities and may not
be called around the configured boundary.

| Authority | Canonical production implementation | Retained compatibility |
| --- | --- | --- |
| Financial | Ledger, Credit, and Settlement entrypoints over the canonical financial SQL contracts | Guarded service promotion and evidence only |
| Draw | Game Engine canonical outcome publication, recovery, certification, and Settlement request pipeline | Read-only projections and local demonstration state |
| Ticket | `ticket_authority` PostgreSQL functions through the canonical Ticket repository | Client-only local demonstration state |
| Hierarchy | Canonical Hierarchy Authority over immutable Platform Management and governed Account persistence | Client-only tree presentation and deprecated Brand/Market reads |
| Scope | Canonical Scope Resolver combining authenticated claims with authoritative Platform and Account relationships | None |
| Operational | Authenticated operational access and authority approval services | Read-only rehearsal and promotion evidence |

## Rules

- Public routes and workers call authority entrypoints, never persistence
  adapters or alternate domain implementations.
- Authority mode switches select exactly one guarded Financial implementation;
  BF-0.1 does not promote or change any mode.
- Legacy result, Ticket, Brand, and Market mutation contracts are retired.
- Client-supplied tenant, hierarchy, Website, Market, Brand, or permission scope
  is never authoritative.
- Shadow and dry-run code may compare or record evidence but may not commit a
  second production mutation.
- Business behavior, immutable models, public compatibility reads, and
  separately governed promotion/rollback controls remain unchanged.

`npm run qa:backend-authority-consolidation` enforces these ownership boundaries.
