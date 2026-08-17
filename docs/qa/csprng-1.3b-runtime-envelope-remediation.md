# CSPRNG-1.3B SP 800-90A Runtime Envelope Remediation

## 1. Executive Summary

CSPRNG-1.3B remediates both HIGH findings from CSPRNG-1.3A without changing the HMAC_DRBG state-transition algorithm. The low-level runtime now enforces a 65,536-byte Generate limit, the 2^48 reseed interval, explicit security-strength profiles, and entropy/nonce/reseed-entropy byte minima. New evidence omits the secret-derived `SeedIdentifier`, qualification streams use compliant chunks, and traceable NIST CAVP vector coverage is part of runtime readiness.

The remediated candidate passes boundary, vector, provider, canonical invocation, migration, and targeted statistical regression. This is internal evidence, not a NIST, CMVP, laboratory, or regulator certification.

## 2. Original Blocked Baseline

- Review baseline commit: `4fdaa7fc4851741f7df9b9ea842409bd33eb72e9`
- Historical qualified DRBG source SHA-256: `0c2639d958dd916e0f6d56168ece697c6cff6b2fd0c3415368613425706c8d46`
- Review result: `CSPRNG_1_3A_BLOCKED`
- Blocking findings: F001 and F002, both HIGH.

Historical CSPRNG-1.1, CSPRNG-1.2A, and CSPRNG-1.2B evidence remains bound to the old hash and was not rewritten.

## 3. Findings Remediation Matrix

The machine-readable matrix is `docs/qa/csprng-1.3b-findings-closure.json`. Final dispositions are:

| Finding | Original severity | Disposition |
| --- | --- | --- |
| F001 Generate/reseed limits | HIGH | REMEDIATED |
| F002 parameter enforcement | HIGH | REMEDIATED |
| F003 vector provenance | MEDIUM | REMEDIATED |
| F004 secret-derived evidence hash | MEDIUM | REMEDIATED |
| F005 exceptional buffer cleanup | LOW | REMEDIATED |
| F006 platform-dependent byte order | LOW | REMEDIATED |
| F007 cancellation attempt evidence | LOW | ACCEPTED_LOW_RISK |
| F008 SP 800-90B evidence | INFO | ACCEPTED_EXTERNAL_DEPENDENCY |
| F009 SP 800-90C classification | INFO | ACCEPTED_EXTERNAL_DEPENDENCY |
| F010 managed-memory erasure | INFO | ACCEPTED_EXTERNAL_DEPENDENCY |

## 4. F001 Generate Limit Remediation

`HmacDrbgRuntime.Generate` rejects non-positive counts and any request above 65,536 bytes before additional-input processing, allocation, Key/V update, output generation, or counter advancement. Exactly 65,536 bytes is allowed; 65,537 is rejected with a stable non-secret diagnostic.

## 5. F001 Reseed Interval Remediation

The maximum reseed interval is `2^48` (`281474976710656`). Instantiate sets `reseed_counter` to 1. Reseed resets it to 1. A successful Generate increments it by one. In accordance with the Generate pseudocode, a call is rejected when the value at call entry is greater than `2^48`; therefore a call entered at exactly `2^48` is the final allowed call and leaves the counter at `2^48 + 1`. The next call requires reseed.

Tests place the private counter at its boundary using test-only reflection. No production state-mutator API was added.

## 6. F002 Security Strength Remediation

The reusable SHA-2 HMAC_DRBG runtime accepts only explicit strengths 128, 192, and 256 bits. Values such as 0, 112, 257, and values above the SHA-256 maximum fail immediately. The production Internal CSPRNG profile remains SHA-256 at 256-bit requested strength.

## 7. F002 Nonce Remediation

Nonce input must contain at least one-half of the requested security strength: 8, 12, or 16 bytes for the supported profiles. The production 256-bit profile supplies 32 bytes. Empty, missing, and one-byte-under-boundary nonces are rejected before session state exists. Nonce secrecy is not claimed or required by this rule.

## 8. F002 Entropy / Reseed Entropy Remediation

Instantiate entropy and reseed entropy must each contain at least the selected security-strength byte count: 16, 24, or 32 bytes. Production supplies 48 bytes to each operation. The validation establishes an input-length contract only; it does not establish formal min-entropy or SP 800-90B validation.

## 9. SeedIdentifier Assessment / Remediation

The old `SeedIdentifier` was SHA-256 over OS entropy, nonce, and draw-bound personalization and was persisted inside provider evidence. It was not needed to verify the authoritative outcome and unnecessarily fingerprinted secret initialization material.

New evidence omits `SeedIdentifier` and records `ExecutionProvenanceIdentifier`, a hash over non-secret draw ID, execution-manifest ID, request ID, provider ID/version, and configuration version. Migration 119 adds disabled-by-default configuration version 2 with the minimized contract. Old evidence and configuration version 1 are retained and remain hash-replay compatible; no historical row is rewritten.

## 10. MEDIUM Findings Disposition

F003 is remediated by traceable CAVP coverage and accurate relabeling of Mosera-created fixtures as regression vectors. F004 is remediated by evidence-contract versioning and omission of the secret-derived identifier from new records. No MEDIUM finding remains.

## 11. LOW Findings Disposition

F005 now zeroes temporary Linux entropy chunks and all OS readiness probes in `finally` blocks. F006 uses explicit big-endian conversion for bounded sampling. F007 remains accepted LOW risk: cancellation before authoritative completion fails closed, but a pre-commit canceled attempt may lack non-authoritative attempt evidence. Changing that operational evidence policy is outside this cryptographic envelope package.

## 12. New Source Hash

The remediated canonical DRBG/sampler source SHA-256 is:

`53ecf20c1690b3e240f00d8df611b7bc57f413aba6434236ed72eb4ac9b74d30`

This is a candidate baseline, not yet a frozen or externally certified implementation. The old hash remains in all historical evidence.

## 13. HMAC_DRBG Core Algorithm Integrity

Key/V initialization, Update, Instantiate, Reseed, and Generate transition ordering were not redesigned. Changes are input-envelope checks before mutation, an explicit byte-order interpretation in bounded sampling, buffer cleanup, and readiness vectors. The production algorithm remains HMAC_DRBG with SHA-256.

## 14. Official/CAVP Vector Coverage

Runtime readiness executes `nist-cavp-cavs14.3-drbg-pr-false-hmac-sha256-count0`, covering Instantiate, Reseed, and two Generate calls and comparing the second `ReturnedBits` in fixed time.

Vector provenance:

- NIST CAVP CAVS 14.3 DRBG vectors, `PredictionResistance = False`, HMAC SHA-256, `COUNT = 0`.
- NIST source: `https://csrc.nist.gov/CSRC/media/Projects/Cryptographic-Algorithm-Validation-Program/documents/drbg/drbgtestvectors.zip`.
- NIST archive: `drbgtestvectors.zip`, SHA-256 `5f7e5658ebd5b4e6785a7b12fa32333511d2acc2f2d9c5ae1ffa16b699377769`.
- Nested archive: `drbgvectors_pr_false.zip`, SHA-256 `73f9965ca0675bc74673aaba0733283a9874f74db1fd4c15bb707a8ab446d32c`.
- Response file: `HMAC_DRBG.rsp`, SHA-256 `4b7d03d4fb48c738c76baf09bd67d054514682f4fee36ff8741bec2ccd77b8d4`.

The existing SHA-256/384/512 Mosera fixtures remain useful deterministic regression vectors but are no longer described as official CAVP vectors. Formal prediction-resistance request semantics are not implemented or claimed.

## 15. Boundary QA Results

Generate 1, 32, 65,535, and 65,536-byte calls pass; 0, negative, and 65,537-byte calls reject. Strength, entropy, nonce, and reseed-entropy exact boundaries and under-boundary cases pass. Counter increment, exact interval call, rejection after the interval, and post-reseed reset pass.

## 16. Rejected-Call State Integrity

Tests fingerprint Key, V, counter, generated-byte count, and previous continuous-test block around rejected calls. Oversized Generate and undersized Reseed leave the fingerprint unchanged. A deterministic continuation after rejection matches an untouched control session. No output, fallback bytes, weaker retry, or partial state advancement occurs.

## 17. Qualification Harness Changes

Large qualification streams are concatenations of normal Generate calls of at most 65,536 bytes. Each call advances the session normally. The final partial chunk is exact, and manifests record the maximum chunk, request count, and final chunk size. The active harness writes under `.qa/csprng-1.3b`; historical CSPRNG-1.2B verification remains pinned to the historical hash.

Public initialization hash assessment:

| Field | Source | OS entropy | Nonce/reseed | DRBG state | Persisted | Public |
| --- | --- | --- | --- | --- | --- | --- |
| `personalizationSha256` | Package ID, sample ID, Git commit, generation timestamp | No | No | No | Yes | Yes |
| `rawSampleSha256` | Generated qualification output bytes | Indirect output only | No direct material | No internal state | Yes | Yes |
| `manifestPayloadSha256` | Canonical non-secret manifest payload | No secret input | No | No | Yes | Yes |
| `assemblySha256` | Built generator assembly bytes | No | No | No | Yes | Yes |
| `qualifiedImplementationHash` | Canonical DRBG source bytes | No | No | No | Yes | Yes |

No raw OS entropy, nonce, reseed material, Key, V, or hash over those secret initialization values is persisted by the remediated generator.

## 18. Statistical Requalification Scope Decision

The HMAC_DRBG transition algorithm did not change. The relevant stream-path change is standards-compliant request chunking, where each 65,536-byte call performs the normal post-Generate Update and counter increment. Consequently, the old CSPRNG-1.2B campaign does not qualify the new hash, but a full 32 GiB rerun is not proportionate for this remediation gate. Targeted multi-stream, Pick, Keno, Matrix, concurrency, restart, and external-harness smoke regression was selected. Independent external review may require a larger campaign for the frozen candidate.

## 19. Targeted Statistical Regression Results

Both runs are preserved in `docs/qa/csprng-1.3b-targeted-statistical-regression.json`.

The first fast run used 2,000 Pick samples and preserved one position-5 result at `p=0.009775221021193757`, just below the predeclared 0.01 threshold. Its two raw sample identities and outputs remain recorded. Keno, Matrix, independence, restart, and all other Pick positions passed.

A separate extended follow-up used 50,000 Pick samples, 20,000 Keno draws, 30,000 Matrix draws, 32 independent workers, 12 restart cycles, and four raw streams. It passed with no blocker; the position-5 Pick result was `p=0.4911858745976905`. The follow-up does not erase or replace the first result. PractRand, dieharder, and NIST SP 800-22 full external qualification were not rerun in this package.

## 20. Production CSPRNG Regression Results

Runtime, boundary, deterministic regression vectors, CAVP vector, unbiased sampling, internal-provider, 100,000-sample bounded distribution, legacy-randomness isolation, and extended targeted qualification checks pass. Build, TypeScript, and migration checks pass.

## 21. Provider / Outcome Authority Regression

The canonical full-chain invocation passes from `CanonicalDrawExecutionAuthority` through one Internal CSPRNG execution, immutable provider evidence, certified outcome publication, settlement, ledger, wallet, completion, commission, and rebate evidence. Same-draw concurrency is exactly once; retry reuses the result; distinct draws remain isolated; restart resumes; and Official Results or Manual Certified manifests never fall back to the CSPRNG.

## 22. SP 800-90A Conformance Status

Internally reviewed status: the selected HMAC_DRBG operating envelope is enforced and the reviewed core transitions are structurally conformant with SP 800-90A Rev. 1. This statement is an engineering assessment, not NIST validation.

## 23. SP 800-90B Boundary Status

`SP800_90B_VALIDATION_NOT_ESTABLISHED`. Mosera requests bytes from OS cryptographic entropy APIs and fails closed on API failure. Byte length does not prove min-entropy. Platform entropy characterization or validated-module evidence remains external.

## 24. SP 800-90C Assessment

The closest candidate remains an RBG2-style construction. The envelope fixes do not resolve the missing validated entropy/module-boundary evidence. Status remains `SP800_90C_CLASSIFICATION_INSUFFICIENT_EVIDENCE`.

## 25. Cryptographic Claims Register Update

`docs/qa/csprng-1.3b-claims-register.json` permits narrowly scoped internal claims and explicitly prohibits SP 800-90B validation, SP 800-90C conformance, NIST/CAVP/CMVP certification, completed independent audit, laboratory certification, regulator approval, or a claim that CSPRNG-1.2B directly tested the remediated source.

## 26. Remaining Findings by Severity

- CRITICAL: 0
- HIGH: 0
- MEDIUM: 0
- LOW: 1 accepted
- INFO/external dependency: 3

## 27. External Dependencies

Remaining dependencies are SP 800-90B entropy evidence or a validated platform/module, independent cryptographic review, any formal CAVP/CMVP or laboratory program, host dump/debug hardening review, regulator approval, and production-grade immutable/WORM evidence storage.

## 28. External Review Readiness

The candidate is ready for independent source and boundary review with all internal HIGH/MEDIUM findings closed. It is not certification-ready as an externally validated module until entropy, module-boundary, long-term evidence custody, and laboratory requirements are resolved.

## 29. Files Created

- `docs/qa/csprng-1.3b-claims-register.json`
- `docs/qa/csprng-1.3b-findings-closure.json`
- `docs/qa/csprng-1.3b-runtime-envelope-remediation.md`
- `docs/qa/csprng-1.3b-targeted-statistical-regression.json`
- `scripts/migrations/local/119_version_csprng_evidence_minimization.sql`
- `scripts/qa/csprng-runtime-envelope.mjs`

## 30. Files Modified

- `package.json`
- `scripts/migrations/migration-manifest.json`
- `scripts/migrations/validate-local-migrations.mjs`
- `scripts/qa/csprng-external-battery-harness.mjs`
- `scripts/qa/csprng-external-qualification-campaign.mjs`
- `scripts/qa/drbg-official-vectors.mjs`
- `scripts/qualification/csprng/external-battery-harness.mjs`
- `services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs`
- `services/game-engine/src/GameEngine.Application/Services/InternalCsprngOutcomeProvider.cs`
- `services/game-engine/src/GameEngine.Application/Services/OutcomeAuthorityHardeningService.cs`
- `services/game-engine/src/GameEngine.Domain/Model/InternalCsprngProviderModels.cs`
- `services/game-engine/tests/GameEngine.Application.Tests/Program.cs`
- `services/game-engine/tests/GameEngine.CsprngExternalSampleGenerator/Program.cs`
- `services/game-engine/tests/GameEngine.CsprngQualification/Program.cs`

Pre-existing unrelated modifications to local runtime inventory/QA are not part of CSPRNG-1.3B.

## 31. Migrations Created, if any

Migration 119 creates an additive provider configuration version with minimized evidence requirements and explicit runtime-envelope metadata. It preserves existing evidence and is disabled by default. Local migration execution applied 119 successfully; validation passed 1,302 checks with zero failures.

## 32. QA Results

PASS: .NET build/test, lint, production build, local migration run/validation, CSPRNG runtime/envelope, deterministic and CAVP vectors, unbiased sampling, internal provider, cryptographic conformance, canonical production invocation, Outcome Authority activation guardrails, historical campaign integrity, external battery harness smoke, internal statistics, legacy isolation, targeted extended qualification, source-hash verification, JSON parsing, and `git diff --check`.

The first targeted fast statistical run is intentionally recorded as blocked by one narrow Pick result; the separately identified larger follow-up passed. Full PractRand, dieharder, NIST SP 800-22, and the 32 GiB campaign were not rerun.

The broader `qa:local-integrated-runtime` was also attempted with its required disposable database flags. It passed runtime inventory, Auth cutover, and seven settlement persistence/execution/recovery stages, then failed at the unrelated settlement-authority-switch check because the Settlement Service endpoint was unreachable. No CSPRNG assertion failed, and frozen settlement/runtime files were not changed in this package.

## 33. Recommended Next Re-review Package

Perform an independent CSPRNG-1.3C cryptographic and module-boundary review against source hash `53ecf20c...d30`, including the accepted LOW cancellation-evidence policy and the external entropy/WORM dependencies. Decide any larger statistical rerun only after that review freezes the candidate.

## 34. Recommended Commit Message

`fix(csprng): enforce SP 800-90A runtime envelope`

## 35. Final Status

`CSPRNG_1_3B_PASS`

Production-grade immutable/WORM storage for large statistical evidence has not been established. Current local evidence must be transferred to appropriate immutable long-term custody before formal external certification or laboratory engagement.
