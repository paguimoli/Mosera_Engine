# BF-7.1 Cross-Authority Integrity Audit

## Result

The 23 frozen production authorities have one declared owner and one canonical
execution boundary. The audit found one competing write path: legacy Game Engine
draw registry and scheduler diagnostics could persist placeholder authority and
schedule state through obsolete repository registrations.

BF-7.1 removes those registrations and persistence calls. The diagnostics remain
available as read-only compatibility surfaces; all durable draw execution,
provider evidence, publication, lifecycle, and recovery continue through the
canonical Game Engine authorities.

## Audit Coverage

The audit inspected application routes, workers, .NET registrations and hosted
services, authority services, repositories, migrations, SQL functions, readiness
reports, QA gates, and the service resource ownership map. The canonical owner
for each authority is recorded in
`src/architecture/authorities/authority-consolidation.ts`.

The following invariants are enforced:

- one ownership record per frozen authority;
- one execution and registration identity per authority;
- one complete readiness record per authority;
- no duplicate service resource registration;
- no legacy durable draw repository in production dependency injection;
- exactly one registration for each canonical Game Engine outcome authority;
- retired Result and legacy Ticket mutation routes remain closed.

## Compatibility And Migration History

Legacy draw repository adapters remain test fixtures for historical migration
contracts but are not registered or reachable in production. Existing immutable
tables are not dropped because they preserve previously recorded evidence.
Settlement consumption evidence and canonical draw orchestration evidence are
complementary: one tracks downstream consumption and completion, while the other
tracks execution leases, attempts, and acknowledgements.

No schema, business rule, authority mode, or public mutation contract changes in
BF-7.1.
