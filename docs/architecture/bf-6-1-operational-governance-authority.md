# BF-6.1 Operational Governance Authority

## Decision

`operational_governance` is the sole production authority for operational command authorization, policy-driven approval validation, execution coordination, immutable evidence, correlation, causation, and audit.

Domain authorities retain their existing business rules. They may execute an operational mutation only as the callback of `executeGovernedOperation`; the governance authority does not reproduce domain validation or change domain ownership.

## Command Flow

1. Existing authentication resolves the actor, session, roles, permissions, and canonical scopes.
2. `request_command` binds the immutable command to the active policy version and canonical request hash.
3. `authorize_command` evaluates the configured approval category.
4. A PostgreSQL advisory lock serializes execution for the durable command identity.
5. The domain authority performs the command.
6. Append-only execution evidence and command events record success or failure.
7. An identical retry returns the existing result; a conflicting payload fails closed.

The policy catalog supports `NO_APPROVAL`, `SINGLE_APPROVAL`, `DUAL_APPROVAL`, and `SYSTEM_APPROVAL`. Approval requirements are versioned data rather than route constants. Two-person approval requires two distinct authenticated identities.

## Break Glass

Break-glass use is explicit in command evidence. The active command policy must allow it, the existing MFA and different-actor rules remain authoritative, and reason, session, correlation, scope, and result evidence are always retained. Break glass bypasses neither authorization nor audit.

## Governed Production Paths

- Settlement, Ledger, and Credit authority promotion execution
- Authority dry-run, promotion, and certification capture
- Platform Management lifecycle actions
- Break-glass lifecycle actions
- Administrative session revocation
- Ledger-reference remediation approval capture

Game Engine, Outcome, Draw, Ticket, Settlement, Financial, Hierarchy, Scope, and Compensation business logic remains unchanged. Their operational activation and recovery entrypoints must use this boundary when exposed as production commands.

## Immutability and Recovery

Policies, commands, approvals, events, and execution evidence reject updates and deletes. Failed attempts remain visible and may be retried under the same command identity. Successful commands are never executed twice. Corrections require a new correlated command and evidence chain.

## Deferred

- Operational UI, workflow designer, notifications, external IAM, and cloud KMS
- Promotion of policy-administration APIs; policy versions are migration-governed for Backend Freeze
- Cross-process command dispatch; current execution is synchronous behind durable PostgreSQL coordination
