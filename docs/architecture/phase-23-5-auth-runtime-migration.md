# Phase 23.5 - Authentication Runtime Migration & Coexistence Plan

## Scope

Phase 23.5 defines the production migration strategy from the existing Next.js authentication implementation to the native .NET Auth Service. It does not activate Auth Service runtime login, token issuance, OAuth endpoints, or migration execution.

## Current Authority

Existing platform authentication remains authoritative. The Auth Service remains independent and diagnostic-only until explicit migration approval.

## Identity Migration

Existing users map into Auth Service identities through immutable Login IDs, credential metadata, roles, claims, memberships, sessions, and lifecycle state. The migration requires:

- no duplicate identities;
- no permission loss;
- no audit history loss;
- no hard deletes;
- preserved legacy correlation IDs.

Memberships are scoped to tenant, brand, market, operator, jurisdiction, and PAM relationships. Business hierarchy remains outside Auth ownership.

## Credential Migration

Passwords, password hashes, MFA secrets, recovery codes, OAuth identities, API clients, service accounts, and federated identities are mapped into credential records with secret material references only.

If password hash formats differ, transparent password upgrade is preferred on successful future login. Forced password reset is reserved for unsupported or unsafe legacy hash formats.

## Session Migration

Session migration supports parallel validation between current Next.js sessions and future Auth Service sessions. The cutover model includes controlled activation, forced logout strategy, partial rollback, and full rollback.

Legacy sessions remain authoritative until migration approval.

## Token Migration

Legacy tokens remain valid during coexistence according to their original expiration and revocation rules. New JWT, opaque, refresh, and service tokens remain modeled but disabled until runtime approval.

Expiration and revocation strategies must be validated before any issued Auth Service token is accepted by platform services.

## OAuth/OIDC Migration

OAuth/OIDC migration order:

1. Auth Service deployed with no traffic.
2. Shadow validation diagnostics.
3. Dual authentication compatibility checks.
4. Admin migration.
5. Internal service migration.
6. Player migration.
7. OAuth/OIDC activation.
8. Legacy retirement.

Each phase requires success criteria, rollback criteria, and an operator approval gate.

## Compatibility Layer

The temporary compatibility layer models:

- legacy session validator;
- legacy token validator;
- legacy user lookup;
- migration bridge;
- feature flags;
- compatibility diagnostics.

No runtime compatibility implementation is enabled in this phase.

## Operational Runbook

Deployment procedure:

1. Deploy Auth Service with runtime traffic disabled.
2. Validate health and diagnostics.
3. Run migration QA.
4. Confirm existing platform auth remains authoritative.
5. Preserve rollback to legacy-only mode.

Rollback procedure:

1. Disable dual-auth feature flags.
2. Stop accepting Auth Service sessions/tokens.
3. Continue legacy validation.
4. Preserve audit evidence.
5. Escalate migration blockers for operator review.

Partial rollback applies the same sequence to the affected identity class, client type, tenant, brand, market, or service.

Credential failure procedure:

1. Keep legacy credential path authoritative.
2. Disable credential migration for impacted credential class.
3. Preserve failed mapping evidence.
4. Require operator approval before retry.

Session failure procedure:

1. Keep legacy sessions active.
2. Disable Auth session acceptance.
3. Run session mismatch diagnostics.
4. Avoid forced logout unless explicitly approved.

OAuth outage procedure:

1. Disable OAuth runtime flags.
2. Preserve legacy auth.
3. Revoke affected Auth Service token families if runtime tokens were ever issued.
4. Resume only after approval.

## Exit Criteria

Phase 23.5 exits when migration, coexistence, compatibility, rollback, and runbook artifacts are in place and migration readiness remains blocked by default.
