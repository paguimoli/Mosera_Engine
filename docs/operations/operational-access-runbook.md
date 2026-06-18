# Operational Access Runbook

## Purpose

This runbook covers production-first recovery and access-hardening procedures for platform operators. It does not define any authentication bypass, MFA bypass, impersonation path, hidden admin route, or master override login.

All recovery actions must be auditable. Break-glass accounts are reserved for exceptional operational recovery only.

## Admin Lockout Recovery

1. Confirm the incident is an administrative access incident and not an application outage.
2. Attempt login with a normal Super Admin account.
3. If normal Super Admin access is unavailable, use one configured break-glass account.
4. Complete MFA challenge for the break-glass account.
5. Review operational inventory:
   - `GET /api/admin/access/users`
   - `GET /api/admin/access/break-glass`
   - `POST /api/admin/access/break-glass/{userId}/disable`
   - `POST /api/admin/access/break-glass/{userId}/restore`
6. Reset or recover the affected administrator using the approved local or production password reset process.
7. Revoke stale or suspicious sessions:
   - `GET /api/admin/sessions`
   - `POST /api/admin/sessions/revoke`
   - `POST /api/admin/users/{userId}/revoke-sessions`
8. Confirm audit events were generated for break-glass login, password reset, and session revocation.
9. Exit the break-glass session and revoke it.

## Password Reset Procedure

Local QA recovery can use:

```bash
npm run auth:reset-password -- --username <username> --password <new-password>
```

Rules:

- Use the existing password policy.
- Do not print or store the password in logs.
- Do not create users.
- Do not disable MFA.
- Do not modify login behavior.
- Confirm the reset with `/api/auth/login`.
- Confirm `/api/auth/me` with the returned session token or complete MFA if challenged.

Production recovery must use the approved operational credential process for the deployment environment and must produce an audit trail.

## Break-Glass Account Usage Procedure

Break-glass accounts are explicitly classified as `BREAK_GLASS`, must be Super Admins, and must have MFA enabled.

Bootstrap exactly two accounts with:

```bash
npm run auth:bootstrap-break-glass
```

Required environment variables:

- `BREAK_GLASS_1_USERNAME`
- `BREAK_GLASS_1_EMAIL`
- `BREAK_GLASS_1_PASSWORD`
- `BREAK_GLASS_1_TOTP_SECRET`
- `BREAK_GLASS_2_USERNAME`
- `BREAK_GLASS_2_EMAIL`
- `BREAK_GLASS_2_PASSWORD`
- `BREAK_GLASS_2_TOTP_SECRET`

Optional labels:

- `BREAK_GLASS_1_LABEL`
- `BREAK_GLASS_2_LABEL`

Rules:

- Do not use break-glass accounts for daily administration.
- Do not share TOTP secrets.
- Rotate credentials after every use.
- Revoke the break-glass session after recovery.
- Review audit events after use.
- A break-glass account can only be disabled or restored through the audited lifecycle APIs by a different authenticated break-glass account.
- A break-glass account cannot disable or restore itself.

## Session Compromise Procedure

1. Identify the affected user and active sessions with `GET /api/admin/sessions`.
2. Revoke the specific compromised session with `POST /api/admin/sessions/revoke`.
3. If compromise scope is unclear, revoke all user sessions with `POST /api/admin/users/{userId}/revoke-sessions`.
4. Reset the user password if credentials may be compromised.
5. Require MFA re-verification or replacement when the MFA device may be compromised.
6. Confirm `SESSION_REVOKED` or `ALL_USER_SESSIONS_REVOKED` audit events.

## MFA Device Replacement Procedure

1. Verify the request through the organization-approved identity proofing process.
2. Use an authenticated Super Admin session.
3. Review the target account status and current MFA visibility through the operational inventory endpoint.
4. Replace or re-enroll MFA using the existing MFA flow. Do not disable MFA as a shortcut.
5. Revoke existing user sessions after replacement.
6. Confirm audit events for MFA and session operations.

## QA Validation

Run:

```bash
QA_ADMIN_SESSION_TOKEN=<token> npm run qa:operational-access
```

Optional break-glass MFA validation:

```bash
QA_ADMIN_SESSION_TOKEN=<token> \
QA_BREAK_GLASS_USERNAME=<username> \
QA_BREAK_GLASS_PASSWORD=<password> \
QA_BREAK_GLASS_TOTP_SECRET=<secret> \
npm run qa:operational-access
```

The QA harness validates operational inventory, break-glass inventory, session inventory, MFA enforcement when break-glass credentials are supplied, and session revocation for the test break-glass session.
