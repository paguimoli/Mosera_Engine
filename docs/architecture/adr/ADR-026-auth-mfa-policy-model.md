# ADR-026 - Auth MFA Policy Model

## Status

Accepted

## Context

MFA requirements differ by identity type, role, operation, policy, and risk signal.

## Decision

MFA is policy-driven. The model supports requirements by identity type, role, policy, privileged operation, and suspicious login signal.

Supported methods are TOTP, WebAuthn/passkey, email OTP placeholder, SMS OTP placeholder, and recovery code placeholder. Remembered devices and step-up authentication are modeled but not implemented.

## Consequences

- MFA enforcement can be expressed without hard-coding each future endpoint.
- Production MFA verification remains deferred.
- Services can later consume MFA policy outcomes for local enforcement.
