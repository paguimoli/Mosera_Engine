# BF-6.2 Operational Security Authority

## Decision

The BF-6.1 Operational Governance Authority remains the sole privileged-command boundary. BF-6.2 adds one security policy and evidence layer to that boundary; it does not introduce a competing approval or execution authority.

Production privileged commands require an authenticated identity, canonical scope and permission validation, a short-lived privileged session bound to recent Auth Service MFA evidence, the policy-required independent approvals, and an immutable authorization decision. Missing or unavailable evidence fails closed.

## Separation Of Duties

- A requester cannot approve their own command.
- An approver cannot execute the same command.
- A break-glass requester cannot approve their own access.
- Production activation requires two independent human approvals.
- Manual certified submissions, configuration publication, and outcome recovery require an independent human approval.
- The command executor is the authenticated command requester and must own the privileged session.

## Privileged Sessions

Privileged sessions are append-only grants layered over an ordinary authenticated session. They require a reason, ticket reference, MFA evidence, and bounded expiry. Break-glass grants also reference an independently approved `BREAK_GLASS_LIFECYCLE` command. Break-glass grants have a maximum duration of 15 minutes; ordinary privileged grants have a maximum duration of 30 minutes. Termination is recorded as an immutable event, immediately prevents privileged use, and revokes the underlying Auth Service session.

The Auth Service remains identity and MFA authority. In production, the operational layer accepts only recent successful `MFA_VERIFIED` audit evidence belonging to the same identity.

## Game Engine Boundary

Production activation and recovery endpoints validate a pre-authorized Operational Governance command before invoking domain authorities. The Game Engine does not create approvals or privileged sessions. Manual Certified Provider currently has no public runtime endpoint; any future endpoint must use the same command types and validation evidence before submission.

## Fail-Closed Rules

Production execution is denied when persistence, policy, MFA evidence, session evidence, approvals, identity binding, or separation-of-duties evidence is unavailable. Non-production execution remains explicit and records `NOT_REQUIRED_NON_PRODUCTION`; that evidence can never be reused for production.
