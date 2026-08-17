# CSPRNG-1.3C Fresh Cryptographic Re-Review

## 1. Decision

`CSPRNG_1_3C_PASS_WITH_LOW_RISK_FINDINGS`

The remediated Internal CSPRNG baseline has no identified CRITICAL, HIGH, or MEDIUM finding. The selected production profile is structurally consistent with HMAC_DRBG in NIST SP 800-90A Rev. 1, and focused QA demonstrates the request envelope, official vector, provider isolation, unbiased sampling, durable idempotency, recovery, and certificate-bound full chain.

Two LOW findings remain. First, the reusable DRBG API does not terminally destroy a session after every exceptional state-transition failure and one direct V replacement does not zero the replaced managed array. Second, cancellation can omit non-authoritative attempt evidence. The canonical production wrapper destroys the DRBG session in `finally`, creates no fallback output, and commits no outcome on either condition. These are not release blockers for the reviewed path, but both should be remediated before formal external review.

This is an internal engineering assessment. It is not NIST validation, CAVP/CMVP validation, laboratory certification, regulator approval, or an independent cryptographic audit.

## 2. Frozen Review Target

| Item | Frozen value |
| --- | --- |
| Git commit | `1061cfcec9fb1fc78b2d2609ea7f283157842791` |
| Commit date | `2026-08-16T18:50:49-06:00` |
| Review timestamp | `2026-08-17T16:18:00Z` |
| Canonical DRBG/sampler source SHA-256 | `53ecf20c1690b3e240f00d8df611b7bc57f413aba6434236ed72eb4ac9b74d30` |
| Historical pre-remediation source SHA-256 | `0c2639d958dd916e0f6d56168ece697c6cff6b2fd0c3415368613425706c8d46` |
| Game Engine target | `net10.0` |
| Qualification generator target | `net10.0` |
| .NET SDK | `10.0.301` |
| .NET runtime | `10.0.9` |
| Review host | macOS 26.6, x64 |
| Local Game Engine image | `sha256:5117947f85f768bd6d84690b1a5b1cc95ec298a62b38ee5a7bda17d3917e1a29` |
| External battery image | `sha256:e7a0577d56f06d672d62db2533b25dba44796703887e9ffb95635f153f8a6979` |
| Cryptographic dependencies | .NET BCL `HMACSHA256`, `HMACSHA384`, `HMACSHA512`, `RandomNumberGenerator`, and platform OS entropy APIs |

The local Game Engine image predates commit `1061cf...` and is not evidence of a remediated production image. The source and host-built assemblies are the reviewed target. The Dockerfile uses mutable `sdk:10.0` and `aspnet:10.0` tags, so a release image must be rebuilt, digest-pinned, and attested before deployment or laboratory packaging.

### Relevant source hashes

| Source | SHA-256 |
| --- | --- |
| `CertifiedCsprngRuntimeServices.cs` | `53ecf20c1690b3e240f00d8df611b7bc57f413aba6434236ed72eb4ac9b74d30` |
| `InternalCsprngOutcomeProvider.cs` | `4d401c5bdeb90d9851d415ffdc3884118a49e024306a7dfca95e62921e09e0a0` |
| `OutcomeAuthorityHardeningService.cs` | `ca5bb6cdeb8b1aac595206429edcc495825fc45abfd53a28835f0896dcace1f4` |
| `InternalCsprngProviderModels.cs` | `36a029419d4b46fcfac7304164905f4e1b5cacc2b89af6ea2e09c2e704dc4ce0` |
| External sample generator `Program.cs` | `8d6bf14c8ad6d05de4a1ae60b3226bc53d9f387129be5035080e29346bf240fb` |
| Qualification `Program.cs` | `67b5af9b10b5b6f3b945f0bb1c7f62472933a84ca3e559bf27f3dd342885584e` |

## 3. Standards Baseline

- NIST SP 800-90A Rev. 1, Recommendation for Random Number Generation Using Deterministic Random Bit Generators, is the primary DRBG implementation baseline.
- NIST SP 800-90B, Recommendation for the Entropy Sources Used for Random Bit Generation, defines the external entropy-source boundary.
- Final NIST SP 800-90C, Recommendation for Random Bit Generator Constructions, is the construction assessment layer.
- NIST CAVP CAVS 14.3 HMAC_DRBG vectors are conformance test inputs, not proof of CAVP validation.

Authoritative sources:

- https://csrc.nist.gov/pubs/sp/800/90/a/r1/final
- https://csrc.nist.gov/pubs/sp/800/90/b/final
- https://csrc.nist.gov/pubs/sp/800/90/c/final
- https://csrc.nist.gov/Projects/Cryptographic-Algorithm-Validation-Program/Random-Number-Generators

## 4. Historical Traceability

1. The original Internal CSPRNG implementation established the production integration path.
2. Internal qualification exercised algorithm, sampler, concurrency, restart, and failure behavior.
3. CSPRNG-1.2B performed a 20.5 GiB external statistical campaign against source hash `0c2639...d46`.
4. CSPRNG-1.3A identified two HIGH, two MEDIUM, three LOW, and three INFO findings and returned BLOCKED.
5. CSPRNG-1.3B remediated the request envelope, parameter enforcement, vector provenance, secret-derived evidence, exceptional temporary-buffer cleanup, and byte order.
6. The corrected source hash became `53ecf2...d30`.
7. Targeted requalification preserved one Pick position result at `p=0.009775221021193757` and separately preserved a 50,000-sample follow-up at `p=0.4911858745976905`, plus Keno 20,000 and Matrix 30,000 results.
8. CSPRNG-1.3C re-reviewed the entire corrected target rather than accepting the remediation conclusions by inheritance.

The five uncommitted CSPRNG-1.3A artifacts were treated as immutable historical evidence and were not modified.

## 5. HMAC_DRBG Core State Review

The implementation follows the SP 800-90A HMAC_DRBG structure:

- Instantiate initializes Key to all zero bytes and V to all `0x01` bytes, concatenates entropy, nonce, and personalization in that exact order, then performs Update (`CertifiedCsprngRuntimeServices.cs:370-407`).
- Update performs the `0x00` round and, when data is present, the `0x01` round (`:635-678`).
- Reseed combines fresh entropy and additional input, performs Update, resets `reseed_counter` to 1, and clears the continuous-test prior block (`:482-516`).
- Generate performs optional pre-generation Update, repeatedly computes `V = HMAC(Key, V)`, returns the requested prefix, performs post-generation Update, increments the counter, and records a non-secret output hash (`:409-480`).
- The official CAVS 14.3 SHA-256 reseed vector covers Instantiate, Reseed, first Generate, second Generate, and state continuation (`:559-617`).

No algorithmic state-transition regression was identified in 1.3B.

## 6. Generate Request Envelope

`MaximumBytesPerGenerateRequest` is 65,536. Positive-count and maximum checks execute before additional-input processing, allocation, or state mutation (`CertifiedCsprngRuntimeServices.cs:409-433`). Focused tests demonstrate:

- 65,535 bytes: allowed.
- 65,536 bytes: allowed.
- 65,537 bytes: rejected.
- zero: rejected.
- negative: rejected.
- rejected requests leave Key, V, reseed counter, generated-byte count, and deterministic continuation unchanged.

The public method accepts `int`, so values above `Int32.MaxValue` cannot be represented. The external generator validates its `long` total independently and converts each chunk with `checked` arithmetic.

## 7. Reseed Counter

The counter starts at 1 after Instantiate and Reseed. Generate rejects only when the entry value is greater than `2^48`, so a request at exactly `2^48` is allowed and the next request is rejected (`CertifiedCsprngRuntimeServices.cs:364-365,429-432,471,505`). This matches the SP 800-90A comparison sequence. The `long` representation safely holds `2^48 + 1`; no practical signed overflow path exists before enforced rejection.

## 8. Security Strength and Input Contracts

The reusable runtime accepts 128, 192, and 256-bit profiles and SHA-256/384/512 (`CertifiedCsprngRuntimeServices.cs:367-368,680-720`). SHA-256 can support the listed requested strengths up to 256 bits. The canonical production provider is fixed to SHA-256 at 256 bits, with 48 entropy bytes and 32 nonce bytes (`InternalCsprngOutcomeProvider.cs:17-20,287-304`).

The generic profiles are not used by production and increase review and misuse surface. This is an INFO recommendation, not a correctness defect. Before external certification, either constrain the production-facing profile to SHA-256/256 or explicitly exclude the unused generic profiles from the certified module boundary.

Instantiate requires at least `ceil(strength/8)` entropy bytes and `ceil((strength/2)/8)` nonce bytes. Reseed enforces the same entropy minimum. Null array callers fail before state creation through span conversion or argument handling; empty and undersized spans fail explicitly. These checks establish byte-length contracts only. They do not establish min-entropy.

## 9. Seed Composition, Personalization, and Immediate Reseed

Seed material is an unambiguous byte concatenation of caller-delimited inputs `entropy || nonce || personalization`; the runtime neither serializes values nor uses locale-sensitive conversion (`CertifiedCsprngRuntimeServices.cs:396,722-748`). The canonical provider builds personalization from fixed-format GUID/hash identifiers and a request ID (`InternalCsprngOutcomeProvider.cs:290-304`).

Every production draw obtains separate OS entropy, nonce, and reseed buffers. It instantiates, immediately reseeds with fresh 48-byte entropy and the same draw-bound personalization, then generates. Immediate reseed is standards-consistent, resets the counter to 1, is consistently executed, and adds defense in depth. It also adds one entropy acquisition and some certification scope; it is not formal prediction-resistance request handling.

## 10. Prediction Resistance and Compromise Analysis

Formal prediction-resistance request semantics are not implemented and are not claimed. Per-draw instantiation and immediate reseed reduce cross-draw exposure but must not be labeled prediction resistance.

- Compromise before Generate exposes that draw session's future output.
- Compromise after Generate may expose current state; HMAC_DRBG Update provides backtracking resistance subject to the primitive and memory boundary.
- Compromise after reseed does not reveal the pre-reseed entropy through persisted evidence.
- A compromised Game Engine process can observe live state and is inside the trust boundary.
- A compromised database sees hashes, provider/version IDs, canonical results, and evidence, but not entropy, nonce, reseed bytes, Key, or V.
- Host/kernel compromise defeats the entropy and process-isolation assumptions and cannot be repaired inside this application.

## 11. State Isolation, Concurrency, and Idempotency

The runtime service is stateless; Key and V live in a per-call `HmacDrbgSession`. There is no static DRBG state, pool, or cached session. The canonical provider acquires an execution-manifest lock, resolves an exact provider binding, claims one durable execution, and returns persisted generated evidence on an identical retry (`InternalCsprngOutcomeProvider.cs:28-93`).

The canonical draw authority dispatches only the manifest-bound provider. Official and Manual manifests cannot fall back to Internal CSPRNG (`CanonicalDrawExecutionAuthority.cs:48-76`). QA demonstrated one durable execution under 12 concurrent same-draw calls, independent exactly-once execution for distinct draws, and no duplicate financial or compensation effects.

## 12. Crash and Recovery

Before durable generated evidence exists, a retry creates a fresh isolated session after acquiring the same scope lock. Once generated evidence is atomically persisted, restart recovery returns that evidence and does not regenerate. Publication and settlement retries bind to the existing outcome. The full-chain QA restarted between generation and certification, then completed publication and settlement with one generation, one outcome, one certificate binding, and one financial chain.

Generated-but-uncommitted random material is discarded and zeroed by the provider `finally` path. It cannot become authoritative without durable evidence and certificate binding.

## 13. Zeroization

The canonical provider zeroes entropy, nonce, reseed entropy, personalization, and session state in `finally` (`InternalCsprngOutcomeProvider.cs:287-371`). The runtime zeroes seed material, additional-input copies, replaced Key/V values through `ReplaceWithHmac`, output on failure, previous continuous-test blocks, and session state on Destroy.

Residual LOW finding `CSPRNG-1.3C-F001`:

- The Generate loop directly replaces `session.Value` at line 457 without zeroing the replaced managed array.
- If a state transition throws after state mutation, Generate clears the output but does not terminally destroy the reusable session.
- The canonical provider always destroys the session in its outer `finally`, so the production path cannot continue or accept an output after failure.
- A future direct caller could catch an exception and reuse a changed session. A narrow follow-up should zero the replaced V and terminally invalidate a session after an unsafe state-transition failure.

Even after that fix, .NET GC movement, JIT copies, HMAC internals, crash dumps, debuggers, and host compromise prevent a claim of guaranteed physical erasure.

## 14. SeedIdentifier and Migration 119

New evidence passes `null` for `SeedIdentifier`, and JSON omits it (`InternalCsprngOutcomeProvider.cs:326-348`; `InternalCsprngProviderModels.cs:33`). The replacement `ExecutionProvenanceIdentifier` hashes only draw ID, execution-manifest ID, request ID, provider ID/version, and configuration version. No alternate hash over secret initialization material was introduced.

Remaining global references are classified as follows:

| Reference | Classification |
| --- | --- |
| Nullable domain property and replay hash input | Historical compatibility |
| Application test assertions | Test |
| Migration 095 requirement | Historical configuration v1 |
| Migration 119 removal | Security migration |
| Runtime-envelope QA | Test |

Migration 119 additively creates configuration version 2, removes `seedIdentifier`, adds non-secret provenance and runtime-envelope requirements, and appends a `DISABLED` activation event. It does not rewrite historical rows. Fresh and upgraded databases receive the same idempotent version. The safer configuration cannot become active through migration alone; governed activation remains required. Migration validation passed 1,302 checks, including the remediated configuration and disabled-by-default assertions.

## 15. Sampling Review

Bounded integer generation uses an unsigned 64-bit rejection threshold `(0 - n) mod n`, reads fixed big-endian bytes, rejects values below the threshold, and applies modulo only after acceptance (`CertifiedCsprngRuntimeServices.cs:914-945`). Range 1 is valid; zero is rejected; `NextInt32` computes inclusive ranges through a `long` before converting to `ulong`, including the full signed `int` range.

Keno and Matrix use partial Fisher-Yates without replacement. Every step samples from `[i, length - 1]`, making every ordered prefix uniform and duplicates impossible. `count > population` and non-positive counts reject; `count == population` works. Ascending presentation is applied after selection (`:797-879`).

Pick uses independent with-replacement selections into an integer array. Repetition and leading zeros are preserved positionally. Canonical JSON serializes the array, so `[0,0,1]` is not collapsed to numeric `1`.

## 16. Qualification Generator and Public Hashes

The `net10.0` external generator references `GameEngine.Application`; it does not copy or reimplement HMAC_DRBG. It verifies the exact production source hash before generating. Each request is at most 65,536 bytes, chunks advance one session normally, the final chunk is exact, and SHA-256 covers the concatenated raw output (`GameEngine.CsprngExternalSampleGenerator/Program.cs:11-27,94-138`).

Public initialization and provenance fields:

| Field | Source data | OS entropy | Nonce/reseed | DRBG state | Persisted | Disclosure intent |
| --- | --- | --- | --- | --- | --- | --- |
| `personalizationSha256` | Package ID, sample ID, Git commit, UTC generation time | No | No | No | Yes | Public |
| `rawSampleSha256` | Final generated sample bytes | Output only, no raw input | No raw material | No state | Yes | Public evidence |
| `manifestPayloadSha256` | Canonical non-secret manifest payload | No | No | No | Yes | Public evidence |
| `assemblySha256` | Built generator assembly | No | No | No | Yes | Public evidence |
| `qualifiedImplementationHash` | Reviewed source file | No | No | No | Yes | Public evidence |
| `ExecutionProvenanceIdentifier` | Draw/manifest/request/provider/config identifiers | No | No | No | Yes | Audit-safe |
| `GeneratedBytesHash` | Session output bytes | Output-derived only | No raw material | No state | Yes | Audit evidence; not a seed verifier |

No raw entropy, nonce, reseed material, Key, V, internal state, or hash over secret initialization material is persisted for new qualification or production evidence.

## 17. Vector and Statistical Evidence

The official vector is NIST CAVP CAVS 14.3, HMAC_DRBG SHA-256, `PredictionResistance=False`, `COUNT=0`. It covers Instantiate, Reseed, two Generate operations, and continued state. One authoritative profile vector is adequate for the selected SHA-256/256 production profile when combined with independent boundary and deterministic regression tests. Additional vectors would improve breadth if SHA-384/512 or 128/192 profiles remain in an external certification boundary.

CSPRNG-1.2B remains historical evidence for hash `0c2639...d46`; it is not relabeled as qualification of `53ecf2...d30`. The DRBG transition algorithm did not change, while request-size enforcement and chunking did. The targeted 1.3B regression is proportionate for that change:

- Pick 2,000: position 5 `p=0.009775221021193757`, preserved as a distinct blocked observation.
- Independent Pick 50,000 follow-up: corresponding position `p=0.4911858745976905`, no recurrence.
- Keno: 20,000 draws passed.
- Matrix: 30,000 draws passed.
- 32 independent workers and 12 restart cycles passed.

The prior full campaign remains identifiable as `csprng-1.2b-20260816T185106Z-7eda4e0`, with five samples, 29 execution identities, and 22 preserved anomaly entries. A full campaign rerun is not required for this internal gate. An external laboratory may request a fresh large campaign against the final image and should control that scope.

## 18. Entropy and SP 800-90B Boundary

The application requests bytes from platform cryptographic APIs and fails closed on platform/API errors. The supported implementations target Linux `getrandom`, Windows `BCryptGenRandom`, and macOS `SecRandomCopyBytes`. Per-draw acquisition avoids inherited long-lived state after process or VM cloning.

Mosera has not established source min-entropy, health-test validation at the physical source boundary, or a validated entropy module. Status: `SP800_90B_VALIDATION_NOT_ESTABLISHED`. This is an external evidence dependency, not evidence that the application byte-request path is defective.

## 19. SP 800-90C Assessment

The architecture is structurally closest to an RBG2-style construction: an approved DRBG mechanism is seeded and reseeded from an external entropy source. Formal classification cannot be responsibly claimed without SP 800-90B entropy evidence and a frozen module boundary. Status: `SP800_90C_CLASSIFICATION_INSUFFICIENT_EVIDENCE`.

## 20. Provider, Outcome, and Certificate Binding

Production DI registers one OS entropy provider, one DRBG runtime, one sampler, one Internal CSPRNG provider, and separate Official Results and Manual Certified providers (`GameEngine.Api/Program.cs:42-59`). The draw authority resolves the exact manifest-bound provider/version/configuration and fails closed if it is not active. No request selects a fallback provider.

The durable chain binds draw, execution manifest, game definition version/hash, provider ID/version/configuration, canonical request hash, generated result hash, provider evidence hash, outcome certificate ID/hash, and exact activation signing provider/version/key. Cross-draw certificate substitution, stale signing keys, unverified certificates, and provider substitution are explicitly rejected (`CanonicalDrawExecutionAuthority.cs:25-139`). Append-only database constraints and idempotency keys prevent overwrite and duplicate authority.

## 21. Logging, API, and Leakage Review

A fresh repository search found no production logging or serialization of raw entropy, nonce, reseed bytes, Key, V, or DRBG state. New provider evidence serializes only identifiers, hashes, generated public outcome numbers, timing, and health status. Error messages describe bounds or failure classes without secret values.

No public production endpoint exposes random byte streams, internal state, entropy, seeds, test vectors, or the qualification generator. Qualification projects live under `services/game-engine/tests` and are not registered in production DI or copied by the Game Engine Dockerfile as runnable endpoints.

## 22. Cancellation Review

Residual LOW finding `CSPRNG-1.3C-F002`: `InternalCsprngOutcomeProvider.GenerateAsync` excludes `OperationCanceledException` from its failure-attempt append (`InternalCsprngOutcomeProvider.cs:131-140`). A cancellation before commit fails closed, the lock is released, session secrets are destroyed, and no result/certificate/financial effect is accepted. The residual issue is audit completeness: a claimed execution may lack an explicit canceled attempt row. External reviewers are likely to flag the gap because immutable attempt evidence is an asserted control. Remediation is small: append a distinct canceled attempt using a bounded cleanup token before propagating cancellation.

## 23. Misuse Resistance

Runtime checks prevent unsupported strengths, undersized entropy/nonce/reseed input, invalid request sizes, destroyed-session use, and reseed-interval overrun. Internal session Key/V are not publicly settable. The reseed counter has an internal setter, limiting ordinary callers to the assembly but still allowing application-layer code to influence it. The generic DRBG interface can be injected or directly instantiated by code inside the same backend; production authority controls, exact manifest binding, and DI isolation prevent that from becoming an authoritative outcome silently.

The main misuse-resistance improvements are the LOW terminal-session fix and an INFO-level narrowing/documentation of the certified profile boundary. No production bypass was found.

## 24. Findings Summary

| Severity | Count | Status |
| --- | ---: | --- |
| CRITICAL | 0 | Gate met |
| HIGH | 0 | Gate met |
| MEDIUM | 0 | Gate met |
| LOW | 2 | Defensible, remediation recommended before external review |
| INFO | 5 | Scope, platform, and external evidence dependencies |

The machine-readable register is `docs/qa/csprng-1.3c-findings-register.json`.

## 25. QA Results

| Validation | Result |
| --- | --- |
| Frozen source hash verification | PASS, exact `53ecf2...d30` |
| `dotnet build services/game-engine/GameEngine.sln --no-restore` | PASS, 0 warnings, 0 errors |
| `dotnet test ... --no-restore --no-build` | PASS |
| `qa:drbg-official-vectors` | PASS, 10 checks |
| `qa:drbg-known-answer-tests` | PASS, 7 checks |
| `qa:csprng-runtime-envelope` | PASS, 12 checks |
| `qa:csprng-runtime` | PASS, 14 checks |
| `qa:unbiased-sampling` | PASS, 8 checks |
| `qa:internal-csprng-statistical` | PASS, 100,000 bounded samples |
| `qa:internal-csprng-provider` | PASS, 11 checks |
| `qa:canonical-csprng-production-invocation` | PASS, full chain, concurrency, restart, no fallback |
| `qa:csprng-external-qualification-campaign` | PASS, five samples, 29 executions, 32,244,002,555 verified artifact bytes |
| `qa:csprng-external-battery-harness` | PASS after Docker sandbox permission retry |
| `migrations:local:validate` | PASS, 1,302 checks, 0 failures |

The 20.5 GiB campaign and full PractRand, dieharder, and NIST STS batteries were not rerun. The external harness smoke created only a new disposable 1 MiB sample under ignored `.qa` storage.

## 26. Integrated Runtime Follow-Up

The previously unreachable Settlement Service authority endpoint is classified `environment/transient`. In this review, every Compose service was running, Settlement Service was healthy, and application-network requests returned HTTP 200 from:

- `/health/live`
- `/health/ready`
- `/v1/settlement/authority/readiness`

The earlier failing route used a host/sandbox reachability boundary; container-network access on the correct internal port `8080` succeeds. The canonical CSPRNG full-chain QA also reached settlement and completed one ledger/wallet/completion chain. No CSPRNG settlement-chain regression was found, and no Settlement or runtime file was modified.

## 27. Evidence Custody and External Readiness

Git-tracked manifests and reports retain source hashes, sample hashes, execution identities, anomaly lineage, and tool/environment provenance. Approximately 32.24 GB of raw campaign evidence remains local under ignored `.qa` storage. It is qualification evidence, not production-grade WORM custody.

Before laboratory or regulator engagement:

1. Transfer all five raw samples, 29 execution directories, manifests, sidecars, logs, anomaly records, and 1.3B targeted evidence into versioned object storage with retention lock/legal hold as appropriate.
2. Record independent transfer hashes, signer identity, storage URI/version IDs, retention policy, and verification timestamp.
3. Retain raw samples when the reviewer may rerun batteries; a selected-artifact-only package is insufficient for reproducibility.
4. Rebuild a digest-pinned production image from commit `1061cf...`, record the SBOM and image attestation, and bind it to the source hash.

External review package readiness: `READY_WITH_LOW_RISK_FINDINGS`. The source, conformance matrix, threat model, claims, vectors, QA, statistical evidence, anomalies, remediation history, full-chain evidence, and external dependencies can be assembled coherently. Close F001/F002 and freeze evidence custody before formal laboratory submission.

## 28. Recommended Next Gate

Run a narrow CSPRNG-1.3D remediation for:

1. Terminal session invalidation and complete replaced-state zeroization on exceptional state transitions.
2. Durable canceled-attempt evidence using a bounded cleanup context.
3. Tests that inject transition failure and cancellation without changing DRBG success semantics.

Afterward, perform an independent specialist source review against a rebuilt, digest-pinned production image. Do not rerun the full statistical campaign unless the remediation changes successful output-generation semantics or the external reviewer requires it.

## 29. Artifact Set and Commit Policy

This package creates:

- `docs/qa/csprng-1.3c-cryptographic-rereview.md`
- `docs/qa/csprng-1.3c-sp800-90-conformance-matrix.json`
- `docs/qa/csprng-1.3c-threat-model.md`
- `docs/qa/csprng-1.3c-findings-register.json`
- `docs/qa/csprng-1.3c-claims-register.json`
- `docs/qa/csprng-1.3c-external-review-readiness-checklist.md`

No production source, migration, runtime configuration, QA script, historical artifact, or unrelated worktree file is modified. No commit is created. On approval, commit the five preserved 1.3A artifacts as the blocked historical review and the six 1.3C artifacts as a separate fresh-review evidence commit.
