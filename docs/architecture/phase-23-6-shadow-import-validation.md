# Phase 23.6 - Shadow Identity Import Validation

## Scope

Phase 23.6 introduces read-only tooling to answer whether the current platform identities can migrate into the native Auth Service today.

No identities are imported, persisted, modified, deleted, authenticated, or issued tokens in this phase.

## Source Data

The shadow import source is modeled around existing platform data:

- platform users;
- roles and permissions;
- sessions;
- password hash metadata;
- MFA metadata;
- player accounts;
- agent accounts;
- admin accounts;
- service accounts;
- API clients.

The Auth Service runtime uses a non-persistent source adapter by default. Production database wiring remains an explicit later adapter and must preserve the same read-only contract.

## Identity Mapping

Each legacy identity maps deterministically to:

- `IdentityId`;
- `LoginId`;
- `IdentityType`;
- `LifecycleState`;
- memberships;
- roles;
- claims;
- credentials.

Identifiers are generated from stable source-system and source-id values so repeated validation produces the same report.

## Validation

The validator detects:

- duplicate usernames;
- duplicate emails;
- duplicate login IDs;
- orphan identities;
- missing credentials;
- invalid role mappings;
- invalid memberships;
- unsupported credential types;
- missing lifecycle state;
- unknown account types;
- orphan sessions.

Errors become migration blockers. Warnings remain visible in the report for operator review.

## Shadow Import

Shadow import creates in-memory identities only. It never writes to the Auth Service schema, existing platform tables, sessions, tokens, credential stores, or audit tables.

The run result reports:

- `readOnly: true`;
- `persisted: false`;
- `authenticated: false`;
- `sessionsCreated: false`;
- `tokensIssued: false`;
- `legacyAuthChanged: false`;
- `writeOperationsAttempted: 0`.

## Diagnostics APIs

- `GET /api/auth-service/shadow-import-status`
- `GET /api/auth-service/migration-validation`
- `GET /api/auth-service/migration-report`
- `POST /api/auth-service/shadow-import/run`

The POST endpoint performs validation only. It does not persist a run.

## Reporting

The migration report includes:

- migration summary;
- identities discovered;
- identity type counts;
- conflicts;
- warnings;
- errors;
- migration blockers;
- estimated migration duration;
- readiness score;
- exportable JSON payload.

## QA

`npm run qa:shadow-import` validates:

- Auth Service build;
- Auth Service tests;
- documentation presence;
- read-only behavior;
- no DB writes;
- deterministic report behavior;
- legacy auth unchanged.

## Exit Criteria

Phase 23.6 exits when the shadow import services, diagnostics APIs, tests, documentation, and QA harness exist while legacy authentication remains authoritative and unchanged.
