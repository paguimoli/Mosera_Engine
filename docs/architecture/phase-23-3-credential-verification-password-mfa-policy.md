# Phase 23.3 - Credential Verification Architecture & Password/MFA Policy

## Scope

Phase 23.3 defines the Auth Service credential verification architecture without enabling production authentication. The existing platform authentication path remains unchanged.

## Credential Verification Architecture

Credential verification is provider-based. The Auth Service resolves an identity by immutable Login ID or alias, checks lifecycle eligibility, resolves enabled credentials, selects the credential verifier, evaluates credential proof, evaluates MFA policy, emits audit evidence, and returns a structured result.

The flow does not create sessions and does not issue tokens.

Verifier contracts are defined for password, TOTP, WebAuthn/passkey, federated OAuth, PAM, API key, client secret, and certificate credentials. Secret values are not present in result or audit models.

## Lifecycle Gate

Lifecycle state controls authentication eligibility:

- `Active`: may proceed to credential verification.
- `PendingActivation`: returns pending verification.
- `Locked`: returns a distinct locked result.
- `Suspended`, `Disabled`, `Archived`, and `Deleted`: denied.

## Password Policy

Passwords remain optional. The policy model includes minimum and maximum length, complexity rules, compromised password screening placeholder, reuse prevention placeholder, expiration placeholder, reset-required and temporary-password flags, failed-login lockout, lockout duration, admin-forced reset, and passwordless support.

Hashing implementation is deferred. Argon2id is preferred for future implementation, with final selection deferred until the implementation phase. Plaintext password storage is prohibited.

## MFA Policy

MFA can be required by identity type, role, policy, privileged operation, or suspicious login signal. Supported methods are modeled as TOTP, WebAuthn/passkey, email OTP placeholder, SMS OTP placeholder, and recovery code placeholder.

Remembered devices and step-up authentication are placeholders. Production MFA verification is not implemented in this phase.

## Diagnostics

The Auth Service exposes architecture-only diagnostics:

- `GET /api/auth-service/credential-verification-model`
- `GET /api/auth-service/password-policy`
- `GET /api/auth-service/mfa-policy`
- `GET /api/auth-service/authentication-eligibility`
- `GET /api/auth-service/credential-verifiers`

No login or token issuance endpoints are added.

## Deferred Implementation

Deferred items include password hashing, password reset, TOTP enrollment and verification, WebAuthn/passkey implementation, compromised password screening, recovery codes, step-up authentication, session creation, token issuance, and current platform auth migration.

## Exit Criteria

Phase 23.3 exits with credential policy models, verifier contracts, lifecycle eligibility rules, tests, QA, and documentation in place while production authentication remains disabled.
