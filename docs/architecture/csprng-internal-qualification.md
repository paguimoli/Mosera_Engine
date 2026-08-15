# Internal CSPRNG Qualification Evidence

Status terminology: **INTERNAL QUALIFICATION**. This document does not claim independent laboratory certification.

## Qualified Boundary

The implementation under qualification is owned by `services/game-engine`:

- `AutoOsEntropyProvider` selects the supported platform entropy API and fails closed when none is available.
- `HmacDrbgRuntime` implements HMAC_DRBG with SHA-256 for the Internal CSPRNG production provider.
- `CertifiedCsprngSampler` maps output with 64-bit rejection sampling and partial Fisher-Yates selection.
- `InternalCsprngOutcomeProvider` creates one isolated session per draw, obtains fresh entropy and nonce material, reseeds before selection, zeroizes sensitive material, and writes hash-only evidence through `CanonicalOutcomeProviderAuthority`.
- `CanonicalOutcomeAuthority` validates immutable provider evidence before publishing an outcome.

## Qualification Method

`npm run qa:csprng-qualification-fast` runs deterministic vectors and reduced statistical samples suitable for routine regression.

`npm run qa:csprng-qualification-extended` generates independent raw streams and evidence under `.qa/csprng-1`. It evaluates raw-bit statistics, representative bounded ranges, Keno 20-of-80, Pick digit positions, Matrix 6-of-49, concurrent stream separation, fresh-session restart behavior, and entropy failure behavior.

Raw output is retained only in the ignored qualification directory. Evidence records hashes, implementation identity, environment, sample sizes, thresholds, and results. It never records production entropy, seed material, nonce material, or DRBG state.

## Certification Gates

Internal statistical evidence is supporting evidence, not proof of cryptographic security. Formal certification still requires independent review of the implementation and execution of an approved external battery and laboratory process against retained sample hashes.

The extended qualification fails closed when the production runtime has no caller that invokes `InternalCsprngOutcomeProvider.GenerateAsync`. Registration and readiness alone do not establish an authoritative generation path.
