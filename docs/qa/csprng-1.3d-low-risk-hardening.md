# CSPRNG-1.3D Low-Risk Hardening and Internal Readiness Closeout

## 1. Executive Summary

`CSPRNG_1_3D_PASS`

The two LOW findings from CSPRNG-1.3C are remediated without changing valid HMAC_DRBG output semantics. Candidate source hash `2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c` now has zero unresolved CRITICAL, HIGH, MEDIUM, or LOW findings. Five INFO external dependencies remain accurately classified.

## 2. Original 1.3C Baseline

- Commit: `1061cfcec9fb1fc78b2d2609ea7f283157842791`.
- Source hash: `53ecf20c1690b3e240f00d8df611b7bc57f413aba6434236ed72eb4ac9b74d30`.
- Result: `CSPRNG_1_3C_PASS_WITH_LOW_RISK_FINDINGS`.
- Counts: CRITICAL 0, HIGH 0, MEDIUM 0, LOW 2, INFO 5.

## 3. F001 Root Cause

The Generate block loop assigned a newly computed `V` directly to the session. The replaced managed array was left to garbage collection. Exceptions after a partial state transition cleared output but did not make the reusable session terminal.

## 4. F001 Remediation

Generate now replaces `V` through the existing zeroing helper. Instantiate clears candidate Key/V after exceptional construction. Generate and Reseed invalidate the session after exceptions that can follow state mutation. A shared private state-update helper clears its local state candidates if an update fails.

## 5. Session Invalidation Semantics

Argument, size, entropy-length, nonce-length, and reseed-required checks remain before mutation and leave a valid session reusable. Once Generate or Reseed enters a state transition, any exceptional exit destroys the session. Generate and Reseed then reject that session with `ObjectDisposedException`. Disposal remains idempotent.

## 6. Exceptional Cleanup / Zeroization

Old Key/V arrays, output buffers, temporary input material, prior continuous-test blocks, and tracked output hashes receive best-effort explicit clearing. This does not claim physical erasure across .NET GC movement, JIT temporaries, HMAC internals, dumps, or host compromise. No secret state is persisted or logged.

## 7. F002 Root Cause

`OperationCanceledException` was excluded from the provider failure append path. A durable execution claim could therefore remain without a terminal attempt row even though no result authority or financial effect was accepted.

## 8. F002 Cancellation Evidence Remediation

Post-claim cancellation now uses the existing `RetryableFailure` status, `Retryable` classification, and stable code `OPERATION_CANCELLED`. Evidence is appended with a bounded five-second token independent of the canceled request. Audit-persistence failure is surfaced explicitly. No new database status or migration was required.

## 9. Cancellation Race Analysis

| Boundary | Expected result |
| --- | --- |
| Before entropy | Canceled attempt; no generated evidence |
| After entropy | Buffers cleared; canceled attempt |
| After Instantiate | Session destroyed; canceled attempt |
| After immediate reseed | Session destroyed; canceled attempt |
| After Generate, before persistence | Output discarded; canceled attempt |
| During persistence before commit | Canceled attempt after atomic rollback |
| After durable persistence | Persisted generated result is returned; no contradictory cancellation attempt |

The provider checks durable generated evidence before recording cancellation. Durable authority therefore wins a late cancellation race.

## 10. Authority / Financial Isolation

A canceled attempt is not provider result evidence, an Outcome Certificate, an outcome, a settlement instruction, or a financial effect. It cannot trigger Ledger, Wallet, ticket completion, commission, or rebate behavior. No fallback provider is selected.

## 11. Exactly-Once / Retry Analysis

Cancellation attempts use monotonically allocated attempt numbers under the existing execution-manifest lock. Retry reuses the durable claim and request hash, appends a new attempt, and produces at most one generated evidence row. Conflicting idempotency payloads still fail closed. Repeated cancellation creates distinct attempts, not contradictory authority.

## 12. Historical Compatibility

No schema changed. Existing `CLAIMED`, `RETRYABLE_FAILURE`, `NON_RETRYABLE_FAILURE`, and `COMPLETED` interpretation remains intact. Historical attempts were not backfilled or fabricated. CSPRNG-1.1, 1.2, 1.3A, 1.3B, and 1.3C evidence was not rewritten.

## 13. New Source Hash

- CSPRNG-1.3B/1.3C reviewed baseline: `53ecf20c1690b3e240f00d8df611b7bc57f413aba6434236ed72eb4ac9b74d30`.
- CSPRNG-1.3D candidate baseline: `2f766c198298a8c1038cde1c50e49e34bf89c3645af8fc0ef16221789be9cb6c`.
- Provider source: `deb44d12a5e4b6c41cbaf64f62f5b744f2764916fb68f4009c67d12fbec079cc`.

## 14. HMAC_DRBG Core Integrity

Instantiate, Update, Reseed, Generate ordering, the 65,536-byte request limit, the 2^48 reseed interval, entropy/nonce minimums, security-strength profiles, rejection sampling, and without-replacement sampling are unchanged. Replacing `V = HMAC(Key, V)` through a helper computes the same bytes and only adds clearing of the old array.

## 15. Focused F001 QA

Focused .NET checks prove old `V` clearing, terminal continuous-test failure invalidation, Generate/Reseed rejection after invalidation, idempotent Dispose, and unchanged precondition-rejection state. Official CAVP and deterministic KAT checks remain green.

## 16. Focused F002 QA

Focused .NET checks cover all seven cancellation boundaries, cancellation retry, repeated cancellation attempt uniqueness, non-authoritative evidence, and the post-commit race. No result certificate or authoritative evidence is created by cancellation.

## 17. Broader Cryptographic Regression

Build, focused QA, official vectors, known-answer tests, runtime envelope, runtime/provider contracts, unbiased sampling, cryptographic conformance, readiness, production eligibility, entropy configuration, legacy isolation, recovery, migrations, and the canonical full chain passed. The canonical full-chain run proved same-draw exactly-once generation, restart recovery, certificate binding, settlement handoff, and no Official/Manual fallback.

## 18. Statistical Requalification Decision

No new statistical campaign is required. Valid Generate output bytes and sampling semantics are unchanged. CSPRNG-1.2B remains historical evidence for `0c2639...d46`; targeted CSPRNG-1.3B evidence remains associated with `53ecf2...d30`. Neither is relabeled as direct qualification of the 1.3D hash.

## 19. Findings Closure Matrix

| Finding | Previous | Disposition | Remaining |
| --- | --- | --- | --- |
| CSPRNG-1.3C-F001 | LOW | REMEDIATED | None |
| CSPRNG-1.3C-F002 | LOW | REMEDIATED | None |

## 20. Fresh Mini Re-Review

No invalid state transition, session reuse, conflicting cancellation authority, new secret exposure, public API, fallback, or algorithm change was found. The post-commit race preserves accepted authority. A cleanup-token timeout fails explicitly instead of silently losing the audit requirement.

## 21. Remaining Findings by Severity

CRITICAL 0, HIGH 0, MEDIUM 0, LOW 0, INFO 5. INFO items remain the generic-profile certification boundary, image/provenance freeze, SP 800-90B evidence, SP 800-90C classification, and managed-runtime/host boundary.

## 22. Claims Register Status

The v4 claims delta permits internal claims for the SHA-256/256 HMAC_DRBG profile, enforced SP 800-90A runtime envelope, per-draw state isolation, fail-closed cryptographic lifecycle, unbiased sampling, and completion of internal review with no unresolved material finding. NIST, entropy-validation, independent-audit, laboratory, and regulator claims remain prohibited.

## 23. SP 800-90A Status

The selected application profile is internally assessed as structurally conformant with applicable SP 800-90A Rev. 1 state transitions and request envelope, subject to the .NET primitive/runtime assumptions. This is not CAVP or CMVP validation.

## 24. SP 800-90B External Dependency

`SP800_90B_VALIDATION_NOT_ESTABLISHED`. OS API success and byte counts do not establish source min-entropy or validated source health tests.

## 25. SP 800-90C External Dependency

`SP800_90C_CLASSIFICATION_INSUFFICIENT_EVIDENCE`. Formal classification awaits entropy and module-boundary evidence.

## 26. Production Image/Digest Readiness

The available local Game Engine image is `sha256:5117947f85f768bd6d84690b1a5b1cc95ec298a62b38ee5a7bda17d3917e1a29`. It predates 1.3D and is not the candidate artifact. Base images remain tag-based. A fresh digest-pinned image, SBOM, and provenance attestation remain release-engineering follow-up work.

## 27. WORM Evidence Readiness

Approximately 32.24 GB of historical statistical evidence remains local, with tracked hashes and local-only custody. Immutable/WORM transfer and an independent post-transfer receipt are required before formal laboratory engagement.

## 28. External Review Readiness

`READY`, subject to the explicitly documented external entropy, module, image, custody, specialist-review, and laboratory dependencies. READY is not a certification claim.

## 29. Files Created

- `scripts/qa/csprng-low-risk-hardening.mjs`
- `docs/qa/csprng-1.3d-low-risk-hardening.md`
- `docs/qa/csprng-1.3d-findings-closure.json`
- `docs/qa/csprng-1.3d-claims-register.json`
- `docs/qa/csprng-1.3d-external-review-readiness-checklist.md`

## 30. Files Modified

- `services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs`
- `services/game-engine/src/GameEngine.Application/Services/InternalCsprngOutcomeProvider.cs`
- `services/game-engine/tests/GameEngine.Application.Tests/Program.cs`
- `scripts/qa/csprng-runtime-envelope.mjs`
- `package.json`

The pre-existing runtime inventory and integrated-runtime changes were not modified for this package.

## 31. Migrations Created

None. The existing retryable attempt status and append-only persistence support the remediation.

## 32. QA Results

All in-scope CSPRNG gates passed. `npm run build` required network access for configured Google fonts and then passed. The executable Application test harness runs the new focused gate successfully; its unrelated full run later encounters a pre-existing durable Math Evaluation lookup assertion. That assertion's source was not changed in 1.3D. `dotnet test` exits successfully but the repository's console-style test projects are validated through their explicit `dotnet run` QA commands.

## 33. Historical Evidence Commit Recommendation

Commit historical 1.3A blocked artifacts unchanged as one evidence commit, then 1.3C fresh-review artifacts unchanged as a second evidence commit, then 1.3D runtime/tests/QA/closure artifacts as a third commit. Do not squash chronology into an all-green narrative.

## 34. Recommended Commit Message

`fix(csprng): close low-risk lifecycle and cancellation findings`

## 35. Recommended Next Gate

Freeze and attest a digest-pinned Game Engine image, transfer evidence to WORM custody, then begin independent specialist review. Do not begin another statistical campaign without reviewer scope.

## 36. Final Status

`CSPRNG_1_3D_PASS`
