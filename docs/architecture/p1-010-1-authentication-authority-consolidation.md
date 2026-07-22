# Authentication Authority Consolidation

`Auth Service` is the only authentication mutation authority. Next.js auth routes and operator utilities are compatibility adapters that delegate login, credential, lifecycle, session, and audit operations to it. `AUTH_AUTHORITY` remains `MONOLITH`; `SERVICE` fails closed and no silent fallback exists.

## Remaining Legacy Reads

- `operational-access.service.ts` reads `platform_users`, `user_sessions`, and `break_glass_accounts` for the existing administrator inventory screens. It does not mutate authentication state.
- `authority-baseline.service.ts` reads `platform_users` for migration/status evidence.
- `load-testing.service.ts` names `user_sessions` as a legacy load-test target.
- Auth Service compatibility persistence continues to write its own pre-existing `auth_service.sessions`, token, refresh-token, role, permission, and membership tables inside Auth Service transactions. These are not Next.js/Supabase mutation paths.

These reads are migration dependencies only. They must not be used for password verification, session validation, lifecycle decisions, or authentication audit authority.

## Deferred Security Work

Automatic login lockout/rate limiting, production MFA, external federation, OAuth/OIDC provider runtime, WebAuthn/passkeys, and service-token migration remain outside P1-010.1.
