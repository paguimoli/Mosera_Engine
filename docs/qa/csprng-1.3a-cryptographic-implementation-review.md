# CSPRNG-1.3A Cryptographic Implementation Review

## 1. Executive Summary

Final review decision: `CSPRNG_1_3A_BLOCKED`.

Mosera's HMAC_DRBG Key/V initialization, Update, Reseed transition, Generate transition, per-draw state isolation, OS entropy failure behavior, rejection sampling, partial Fisher-Yates sampling, provider selection, and outcome/certificate binding are structurally sound in the reviewed canonical path. No raw entropy, nonce, reseed bytes, Key, V, or internal DRBG state was found in production persistence, logging, or a public arbitrary-byte API.

The unchanged qualified runtime nevertheless has two material NIST SP 800-90A Rev. 1 conformance defects: it does not enforce the 65,536-byte Generate request maximum or the 2^48 reseed interval, and it accepts unsupported security-strength/nonce/reseed-entropy parameters. The CSPRNG-1.2 external sample generator exercised the first gap by requesting 1 MiB per Generate call. The empirical CSPRNG-1.2B results remain preserved statistical evidence, but they cannot cure or replace implementation conformance. Per the package stop-the-line policy, production code was not changed.

This is an internal implementation review, not NIST/CAVP/CMVP validation, SP 800-90B validation, independent audit, laboratory certification, or regulator certification.

## 2. Frozen Review Target

| Item | Frozen value |
| --- | --- |
| Review timestamp | `2026-08-16T22:35:36Z` |
| Git commit | `4fdaa7fc4851741f7df9b9ea842409bd33eb72e9` |
| Qualified source | `services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs` |
| Qualified source SHA-256 | `0c2639d958dd916e0f6d56168ece697c6cff6b2fd0c3415368613425706c8d46` |
| Application target | `net10.0` |
| Local SDK/runtime | SDK `10.0.301`; runtime `10.0.9` |
| Observed local production image | `lottery-app-game-engine@sha256:5117947f85f768bd6d84690b1a5b1cc95ec298a62b38ee5a7bda17d3917e1a29` |
| CSPRNG-1.1/1.1A | `e48627cd8fe68a705e691cd30d6cc3d336d9f2eb` |
| CSPRNG-1.2A | `7eda4e0e0d4225bbf098ef3b9587fcd7df5345c9` |
| CSPRNG-1.2B | `4fdaa7fc4851741f7df9b9ea842409bd33eb72e9` |
| CSPRNG-1.2B campaign | `csprng-1.2b-20260816T185106Z-7eda4e0` |

Relevant source hashes are recorded in the machine-readable matrix. The application and external sample generator both target `net10.0` and the generator directly references `GameEngine.Application`; it does not contain a copied DRBG.

## 3. Standards and Versions Used

- [NIST SP 800-90A Rev. 1](https://csrc.nist.gov/pubs/sp/800/90/a/r1/final), final June 2015, as the normative HMAC_DRBG baseline.
- [NIST SP 800-90B](https://csrc.nist.gov/pubs/sp/800/90/b/final), final January 2018, for entropy-source boundary and validation claims.
- [NIST SP 800-90C](https://csrc.nist.gov/pubs/sp/800/90/c/final), final September 2025, for complete RBG construction assessment.
- [NIST CAVP Random Number Generators](https://csrc.nist.gov/projects/cryptographic-algorithm-validation-program/random-number-generators) for validation/evidence terminology.

SP 800-90A Rev. 2 draft or pre-draft material was not treated as normative. The detailed matrix is `docs/qa/csprng-1.3a-sp800-90-conformance-matrix.json`.

## 4. Qualified Implementation Verification

The source hash matched the closed value before review and remained unchanged. Both the application and qualification generator compile the same `HmacDrbgRuntime` from `GameEngine.Application`. No production implementation was copied into test tooling. The production container digest was locally available and matches the digest retained by CSPRNG-1.2B, but this review does not claim a remote registry attestation.

The generator/runtime family alignment is semantically appropriate: both target `net10.0` and ran under .NET 10. HMAC is delegated to .NET cryptography in both contexts. The blocking issue is not SDK-family drift; it is the implementation's absent normative limits and the generator's 1 MiB request size.

## 5. SP 800-90A HMAC_DRBG Conformance

| Requirement | Assessment | Evidence summary |
| --- | --- | --- |
| Initial Key = 0x00 and V = 0x01 | `CONFORMS` | Runtime lines 364-366 |
| Update 0x00/0x01 rounds | `CONFORMS` | Runtime lines 519-551 |
| Instantiate concatenation/order | `CONFORMS` | Runtime lines 367-372 |
| Reseed transition/counter reset | `CONFORMS` | Runtime lines 449-457 |
| Generate pre/post updates and counter increment | `CONFORMS` | Runtime lines 393-431 |
| Approved hash/output size | `CONFORMS_WITH_ASSUMPTION` | .NET HMACSHA256/384/512, lines 564-584 |
| Security-strength selection | `NONCONFORMING` | Any integer >=128 accepted; no hash maximum |
| Nonce enforcement | `PARTIAL` | Production supplies 32 OS bytes; runtime accepts empty |
| Reseed entropy enforcement | `NONCONFORMING` | No minimum checked |
| 2^19-bit request limit | `NONCONFORMING` | No maximum; generator asks for 1 MiB |
| 2^48 reseed interval | `NONCONFORMING` | Counter increments but is never enforced |
| Uninstantiate/state destruction | `CONFORMS_WITH_ASSUMPTION` | Explicit logical zeroing; managed copies remain possible |
| Prediction resistance | `NOT_APPLICABLE` | Not implemented or claimed |
| Traceable official vectors | `INSUFFICIENT_EVIDENCE` | Mosera fixtures have no CAVP vector IDs |

The complete requirement-level evidence and remediation text are in the matrix.

## 6. Instantiate Analysis

Production allocates 48 entropy bytes, 32 nonce bytes, and UTF-8 personalization, then calls SHA-256 HMAC_DRBG at 256 bits. Seed material is exactly `entropy || nonce || personalization`. Initialization fails closed if an OS read or runtime operation throws.

Two sessions collide only if the combined initialization material collides. Under the assumptions that the OS source returns independent unpredictable values and SHA/HMAC behave as expected, the 80 OS-sourced bytes dominate uniqueness. The runtime itself does not enforce the nonce requirement or hash-specific security strength, which is finding F002.

## 7. Entropy Provider Analysis

`AutoOsEntropyProvider` chooses exactly one provider from platform detection: Linux `getrandom(..., flags=0)`, Windows `BCryptGenRandom(..., BCRYPT_USE_SYSTEM_PREFERRED_RNG)`, or macOS `SecRandomCopyBytes`. Linux loops until the requested buffer is filled. Non-positive Linux reads and nonzero Windows/macOS statuses throw. Unsupported platforms throw. No timestamp, GUID, process identifier, cached bytes, deterministic PRNG, or other fallback exists.

Linux `flags=0` uses the blocking semantics of `getrandom` until the kernel RNG is initialized. An interrupted call fails execution rather than silently retrying or accepting partial data; this favors safety over availability. OS success does not independently establish min-entropy.

## 8. SP 800-90B Boundary Assessment

Mosera can verify platform support, successful API return, and complete requested byte counts. It requests 48 bytes for instantiate entropy, 32 for nonce, and another 48 for reseed. Mosera does not characterize the noise source, estimate min-entropy, run the platform source's startup/continuous health tests, or possess evidence that the deployed source is SP 800-90B validated.

Legitimate claim: Mosera requests fresh bytes from named OS cryptographic entropy facilities and fails closed on API failure. Unsupported claim: those bytes prove 384 bits of entropy or the entropy source is SP 800-90B compliant. Formal certification requires accepted platform/module evidence or a laboratory-approved entropy boundary.

## 9. Nonce Analysis

The nonce is a separate 32-byte read from the same OS facility after the 48-byte entropy read. SP 800-90A does not require nonce secrecy; for a random nonce at claimed strength 256, the relevant target is at least 128 bits of entropy. The byte length is ample if the OS source assumption holds. It is probabilistically unique, not durably uniqueness-checked. Independence is at the API-call/output level, not a separately validated physical source. The canonical caller is defensible; the low-level runtime's acceptance of an empty nonce is not.

## 10. Personalization / Domain Separation Analysis

Production personalization is UTF-8:

`{ExecutionManifestId:N}|{CanonicalManifestHash}|{RequestId:N}`

The fixed-width GUIDs and canonical hash plus separators avoid practical concatenation ambiguity. The immutable execution manifest binds draw, game definition, provider and configuration; the canonical request ID is deterministically draw-manifest scoped. Product/tenant/environment identifiers need not be duplicated if the manifest hash already commits to the relevant domain. No locale-sensitive conversion or truncation was found.

The CSPRNG-1.2A manifest has one field explicitly described as a public initialization hash: `publicInitialization.personalizationSha256`. Its source is the non-secret UTF-8 string `CSPRNG-1.2A|sampleId|gitCommit|generatedAtUtc`. It contains no OS entropy, nonce, reseed material, or DRBG state; the hash is persisted and intended for public provenance disclosure.

## 11. Reseed Analysis

Immediately after instantiate, production performs a fresh 48-byte OS read and `Reseed(session, reseedEntropy, personalization)`. The reseed transition is `Update(entropy || additional_input)` and resets the counter to 1, conforming structurally. The extra read adds conservative fresh input but does not create a second independently validated source. It is not required to be removed.

The runtime does not validate reseed entropy size. Production supplies enough bytes, but the reusable API can accept an empty reseed, which is part of F002.

## 12. Prediction Resistance Assessment

Mosera does not implement the SP 800-90A prediction-resistance request flag or reseed before every Generate request. Fresh per-draw initialization and one immediate reseed provide strong operational isolation but are not formal prediction resistance. The claims register prohibits that claim.

## 13. State Compromise / Backtracking Analysis

- State learned after Generate: the prescribed post-output Update prevents direct reconstruction of prior state/output under HMAC one-way assumptions.
- State learned before Generate: the current draw's next and subsequent session output is exposed until reseed/destruction.
- One draw compromised: other draws remain separated if OS inputs do not repeat and sessions are not shared.
- Process memory compromised: entropy, nonce, reseed material, Key/V, intermediate HMAC copies, and output can be read during their live window.
- Persisted evidence compromised: raw secrets cannot be recovered from fields found, but `SeedIdentifier` is an unnecessary verifier over secret initialization material.

This is backtracking resistance after state update, not a guarantee against live-state compromise or a formal prediction-resistance claim.

## 14. State Isolation / Concurrency Analysis

`HmacDrbgRuntime` is registered singleton but holds no mutable generator state. Every Instantiate returns a distinct `HmacDrbgSession`; production keeps it in a local variable and destroys it in `finally`. No static Key/V, cache, thread-local generator, or cross-draw session was found.

Before entropy acquisition, the provider takes a manifest-scoped PostgreSQL advisory lock. Claim/evidence uniqueness and request-hash conflict checks ensure one accepted execution. A duplicate returns persisted evidence without regenerating. Lock disposal releases on success and exception. Cryptographic state is not shared through the database lock.

## 15. Restart / Recovery Cryptographic Analysis

Crashes before completion lose only ephemeral secrets/state; restart does not restore or reuse HMAC_DRBG state. A retry creates fresh input. If generation happened but the atomic attempt/evidence transaction did not commit, no authoritative result exists and a new candidate can safely be generated. If commit succeeded but acknowledgement was lost, duplicate lookup returns the persisted result. Once a canonical outcome exists, the draw authority returns it and does not regenerate.

Recovery verifies persisted canonical numbers/result/evidence hashes rather than attempting to reconstruct historical random bytes. This is the correct determinism boundary. Cancellation before atomic completion may leave an incomplete claim/failure audit but not two authoritative outcomes.

## 16. Zeroization / Secret Lifetime Analysis

Lifecycle: OS fills three managed arrays; instantiate combines entropy/nonce/personalization into a temporary seed buffer; HMAC state is held in session Key/V; reseed uses another combined buffer; Generate returns 8-byte sampling buffers; numbers are retained; session and input arrays are zeroed in `finally`.

Explicit zeroization covers seed/reseed combine buffers, replaced Key/V arrays, previous generated blocks, output-hash state, sample buffers, production entropy/nonce/reseed/personalization arrays, and session destruction. Gaps: Linux temporary chunk and readiness probes are not zeroed on exceptional paths. .NET HMAC constructors/runtime internals and GC movement can create copies outside application control. The defensible claim is best-effort logical zeroization, not guaranteed physical erasure.

## 17. Logging / Leakage Analysis

Repository searches found no production logging/serialization of raw entropy, nonce, reseed bytes, Key, V, or internal state. SQL rejects obvious raw secret fields. Error messages expose status/errno and validation text, not secret bytes. No arbitrary production DRBG-byte endpoint exists.

Production `SeedIdentifier` is `SHA-256(entropy || nonce || personalization)` and is persisted in provider evidence. It contains OS entropy and nonce, not reseed material or internal state. It is not described as public and has no necessary evidentiary value; F004 recommends removal in a versioned schema. `GeneratedBytesHash` commits to generated DRBG bytes, not initialization material.

The older `drbg_session_evidence` contract defines persisted `personalization_string_hash`, `nonce_hash`, and `seed_commitment_hash`, but no production repository/writer uses that table. The exact source of `seed_commitment_hash` is not specified by the contract, so no claim about its contents is justified. It should not be activated without a secret-minimizing evidence redesign.

## 18. Bounded-Range Generation Analysis

For upper bound `n`, the sampler computes `threshold = (2^64 - n) mod n`, samples a 64-bit value, rejects values below the threshold, and returns `value mod n`. The accepted set has size divisible by `n`, so every residue has equal multiplicity. Range 1 is valid; the full signed Int32 inclusive range is calculated through Int64/UInt64 without signed overflow. Invalid bounds and zero upper bounds fail.

Each attempt requests eight DRBG bytes. `BitConverter.ToUInt64` is host-endian; this does not affect uniformity, but fixed-input replay portability to a future big-endian target is not guaranteed.

## 19. Keno / Matrix Without-Replacement Analysis

The sampler uses partial Fisher-Yates. At step `i`, it uniformly selects `j` from `[i,n-1]`, swaps, and retains position `i`. Every ordered k-permutation therefore has probability `1/(n(n-1)...(n-k+1))`; every unordered k-combination has equal probability after accounting for `k!` orders. Duplicate universes, invalid counts, and uniqueness/replacement contradictions fail. Ascending sort occurs only after selection and changes presentation, not probability.

Keno 20-of-80 and Matrix-style 6-of-49 use this generic path. The implementation is algorithmically unbiased subject to the bounded sampler and DRBG assumptions.

## 20. Pick Generation Analysis

Pick-family behavior is represented by a number universe with replacement and `DrawOrder`. Each position makes a separate uniform bounded draw; repetition is allowed. Canonical JSON stores an array of integer positions, so `[0,0,1]` remains distinct from `[1]`; leading positions are not collapsed into a single numeric value. The immutable game definition must supply the exact universe/count. No production string formatting should replace this positional authority.

## 21. Output / Reseed Limit Analysis

The canonical sampler requests exactly eight bytes per bounded attempt. Current ordinary game definitions are operationally far below 2^48 Generate calls per per-draw session. However, `Generate` accepts any positive Int32 byte count and never checks `ReseedCounter`. The external qualification generator requests 1,048,576 bytes per call, exceeding SP 800-90A's 65,536-byte maximum by 16 times. `ReseedCounter` starts at 1, resets to 1 on reseed, and increments after every Generate, but no limit or overflow-safe standards boundary is enforced.

This is a material conformance defect requiring a new source baseline. It blocks CSPRNG-1.3A. Prior statistical outputs remain preserved, but their invocation was outside the normative per-request envelope.

## 22. Dependency / Platform Trust Boundary

Mosera relies on .NET `HMACSHA256`/384/512, OS crypto providers beneath those classes, Linux libc/kernel `getrandom`, Windows CNG, macOS Security.framework, the .NET managed memory/runtime, PostgreSQL for authority/idempotency, and the production container/host kernel. This review does not independently validate Microsoft, Apple, Linux, OpenSSL/platform crypto, or cloud/VM entropy internals.

External review must pin source, SDK/runtime, base image, host architecture, OS crypto boundary, deployment image, and entropy/module evidence.

## 23. Container / Deployment Entropy Assessment

The Linux production container calls the host kernel's `getrandom`; entropy state is not baked into the image and application DRBG state is not persisted across restarts. Multiple replicas share the host kernel entropy facility but receive separate calls. Container cloning alone does not clone application DRBG state. VM snapshots or a compromised/defective host kernel remain platform risks; live process snapshots can capture state.

Production Compose runs the Game Engine read-only, non-root, capability-dropped, and on an internal network. These controls reduce host/process attack surface but do not prove entropy quality. Release deployment must pin immutable image digests rather than rely solely on tags.

## 24. Provider Isolation Analysis

The execution manifest binds exact provider ID, provider version, and configuration version. Resolution rejects mismatch, disabled/ineligible/not-ready providers, and non-fail-closed configurations. The draw orchestrator has explicit branches for `InternalCsprng`, `OfficialResults`, and `ManualCertified`. Missing official/manual evidence fails; no CSPRNG fallback is attempted. Internal CSPRNG cannot masquerade as ingestion evidence.

Qualification sample generation remains a test-project executable and is not mapped as a production API. Randomness status endpoints expose registry/readiness metadata, not bytes or seeds.

## 25. Outcome / Certificate Binding Analysis

The request hash binds request, manifest, draw, definition hash, provider/configuration, and generation definition. Generated evidence binds numbers and output/result hashes. Canonical provider JSON binds draw ID, execution manifest, game definition version/hash, evaluator version, ordered primary/bonus arrays, derived data, and source result hash.

Certificate lookup requires the generated result hash and same draw, then verifies exact signing provider/version/key against activation. Authoritative provider evidence requires the matching generated row. Canonical outcome publication rechecks provider evidence and certificate. SQL append-only constraints and canonical payload/hash validation detect ordinary replacement, cross-draw substitution, and rebinding. Database superuser compromise remains outside these application-level guarantees.

## 26. Threat Model Summary

The focused threat model is `docs/qa/csprng-1.3a-threat-model.md`. Strongest controls are fresh per-draw state, exact provider binding, advisory locking, durable idempotency, no raw secret persistence, post-output state update, and immutable hash/certificate linkage. Principal residual risks are OS/.NET trust, live process/host compromise, privileged database bypass, signing-key compromise, managed-memory copies, and the two HIGH standards-envelope findings.

## 27. Fail-Closed Analysis

The canonical path fails on unsupported/unavailable entropy, failed entropy read, health/KAT failure, invalid definition, provider mismatch, non-active provider, lock/database failure, idempotency conflict, sampler error, certificate mismatch, canonical payload mismatch, and publication/settlement handoff failure. No catch returns generated fallback values; generation errors are wrapped as provider failure and secrets are destroyed.

The exception is validation coverage rather than fallback: oversized Generate requests, excessive reseed counters, empty nonce, and undersized reseed input are accepted by the low-level runtime. Those are F001/F002 and the basis for `BLOCKED`.

## 28. Misuse-Resistance Analysis

Canonical production ownership makes correct calls, but `IHmacDrbgRuntime` is broadly reusable inside the application and allows callers to skip nonce/reseed requirements, overstate strength, exceed request limits, or run beyond reseed interval. Future code can call Generate directly instead of the certified sampler. The runtime's readiness still reports ready because its deterministic fixtures do not cover normative rejection behavior.

The smallest remediation is not a new framework: enforce normative parameters inside `HmacDrbgRuntime`, add authoritative limit/negative tests, constrain production construction, and update readiness to fail if those checks fail.

## 29. SP 800-90C Construction Assessment

Closest candidate: RBG2, because an approved DRBG mechanism is instantiated/reseeded from an entropy source. Formal classification is not defensible because Mosera has not established a validated SP 800-90B entropy source in the required RBG security boundary/module and the DRBG runtime has unresolved SP 800-90A defects.

Result: `SP800_90C_CLASSIFICATION_INSUFFICIENT_EVIDENCE`.

This is not independently a blocker for internal operation; F001/F002 are blockers. External certification must resolve the deployed entropy/module boundary and validation route.

## 30. Cryptographic Claims Register

The machine-readable register is `docs/qa/csprng-1.3a-claims-register.json`. Allowed claims are limited to observed construction and controls: use of HMAC_DRBG-SHA-256 in the canonical provider, named OS cryptographic entropy APIs with fail-closed application handling, per-draw state isolation, unbiased reviewed samplers, and immutable canonical evidence binding.

Prohibited claims include unqualified SP 800-90A implementation conformance while blockers remain, 256 bits of validated entropy, SP 800-90B compliance, SP 800-90C conformity, formal prediction resistance, NIST/CAVP/CMVP validation, cryptographic certification, independent audit, or laboratory/regulator certification.

## 31. Findings Register by Severity

The append-only identifier register is `docs/qa/csprng-1.3a-findings-register.json`.

| ID | Severity | Finding | Blocks |
| --- | --- | --- | --- |
| F001 | HIGH | Generate request/reseed interval limits absent; 1.2 generator exceeded request maximum | Yes |
| F002 | HIGH | Security-strength, nonce, and reseed entropy contracts not enforced | Yes |
| F003 | MEDIUM | Existing 'official' vectors lack traceable CAVP identity | No |
| F004 | MEDIUM | Unnecessary persisted secret-derived initialization identifier | No |
| F005 | LOW | Exceptional entropy temporary buffers not always finally-zeroed | No |
| F006 | LOW | Bounded integer conversion is host-endian | No |
| F007 | LOW | Cancellation can omit non-authoritative failure-attempt evidence | No |
| F008 | INFO | SP 800-90B assurance is external | No |
| F009 | INFO | RBG2 classification lacks evidence | No |
| F010 | INFO | Managed zeroization cannot guarantee physical erasure | No |

## 32. QA Results

Targeted closeout QA was selected to avoid rerunning the multi-hour/multi-GiB CSPRNG-1.2B campaign.

| Command/check | Result |
| --- | --- |
| Qualified implementation SHA-256 | PASS, exact frozen hash |
| `dotnet build services/game-engine/GameEngine.sln --no-restore` | PASS, 0 warnings, 0 errors |
| `dotnet test services/game-engine/GameEngine.sln --no-restore --no-build` | PASS, exit 0 |
| `npm run qa:drbg-official-vectors` | PASS, 8 checks |
| `npm run qa:drbg-known-answer-tests` | PASS, 7 checks |
| `npm run qa:csprng-runtime` | PASS, 14 checks |
| `npm run qa:unbiased-sampling` | PASS, 8 checks |
| `npm run qa:internal-csprng-statistical` | PASS, 100,000 samples; counts `10111,10044,9947,9861,10112,10006,9951,10040,9917,10011` |
| `npm run qa:internal-csprng-provider` with disposable `DATABASE_URL` | PASS, 11 checks |
| `npm run qa:cryptographic-conformance` with disposable `DATABASE_URL` | PASS, 8 checks |
| `npm run qa:canonical-csprng-production-invocation` with disposable `DATABASE_URL` | PASS, `CSPRNG_INTERNAL_INTEGRATION_PASS`; one canonical execution/outcome/certificate/settlement chain |
| `npm run qa:csprng-qualification-fast` | PASS, `CSPRNG_INTERNAL_QUALIFICATION_PASS_WITH_EXTERNAL_GATES`; 2 raw samples; 0 blockers |
| `npm run qa:csprng-external-battery-harness` | PASS after Docker-enabled rerun; two isolated 1 MiB smoke samples verified |

Initial invocations of the database-dependent checks without `DATABASE_URL`, and the harness inside the restricted Docker sandbox, failed at environment setup. They were rerun with the disposable database and Docker access without changing code. The external harness smoke run is not a rerun of the CSPRNG-1.2B campaign. It also retains the reviewed 1 MiB-per-Generate behavior that supports F001.

A passing regression suite does not override F001/F002 because current QA does not assert the missing normative rejection behavior.

## 33. Files Created

- `docs/qa/csprng-1.3a-cryptographic-implementation-review.md`
- `docs/qa/csprng-1.3a-sp800-90-conformance-matrix.json`
- `docs/qa/csprng-1.3a-threat-model.md`
- `docs/qa/csprng-1.3a-findings-register.json`
- `docs/qa/csprng-1.3a-claims-register.json`

## 34. Files Modified

No existing file was modified by CSPRNG-1.3A. In particular, the qualified production source was not changed. Pre-existing unrelated worktree modifications in `scripts/operations/local-runtime-inventory.mjs` and `scripts/qa/local-integrated-runtime.mjs` were preserved untouched.

## 35. External Review Readiness

Classification: `NOT_READY`.

An external package should eventually include the remediated frozen source and hash, exact build/runtime/container/host identity, authoritative vector provenance/results, limit/negative tests, entropy/platform/module evidence, canonical invocation/locking/persistence schemas, threat model, claims/findings registers, statistical campaign manifests/anomalies, and WORM evidence references. The current HIGH findings should be remediated before specialist/lab review to avoid reviewing a known nonconforming baseline.

## 36. Known Limitations

- No independent cryptographer or accredited laboratory participated.
- OS entropy quality and .NET/platform HMAC implementation are trust dependencies.
- CSPRNG-1.2B raw evidence remains outside production-grade immutable/WORM storage.
- Existing deterministic fixtures are not traceable CAVP vectors.
- Managed-memory zeroization is best effort.
- The review did not rerun the 20.5 GiB statistical campaign.
- No claim is made that existing production deployment has a CMVP/FIPS validated module boundary.

WORM absence does not block this internal review; it may block formal evidence submission or external certification retention requirements.

## 37. Recommended Remediation Packages, if any

1. `CSPRNG-1.3B - SP 800-90A Runtime Envelope Remediation`: enforce hash-specific security strengths, nonce policy, reseed entropy, 65,536-byte request limit, 2^48 reseed interval, overflow handling, and negative readiness tests. This creates a new qualified source hash.
2. `CSPRNG-1.3C - Authoritative Vector and Evidence Minimization`: import traceable NIST/CAVP vectors; rename existing fixtures accurately; remove/version `SeedIdentifier`, nonce hash, and seed commitment fields that commit secret inputs; tighten temporary-buffer cleanup and explicit endianness.
3. `CSPRNG-1.3D - Requalification Scope`: update the external generator to at most 65,536 bytes per Generate call, preserve all old evidence, and determine/rerun the minimum statistically defensible campaign against the new source hash.
4. External entropy/module review and WORM transfer after the remediated internal gate passes.

## 38. Recommended Next Gate

Do not freeze CSPRNG-1.3A as PASS and do not begin formal independent certification against this source. Approve CSPRNG-1.3B as a deliberately new qualification baseline, then review the code diff and run focused conformance regression before deciding the statistical requalification scope.

## 39. Recommended Commit Message

No commit was created. If the review artifacts are accepted for preservation:

`docs(csprng): record blocked SP 800-90 conformance review`

## 40. Final Status

`CSPRNG_1_3A_BLOCKED`

Reason: unresolved HIGH findings F001 and F002 are material SP 800-90A nonconformances requiring production code changes and a new qualified source hash. The production implementation remained unchanged as required.
