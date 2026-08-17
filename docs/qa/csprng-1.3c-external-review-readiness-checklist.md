# CSPRNG-1.3C External Review Readiness Checklist

## Classification

`READY_WITH_LOW_RISK_FINDINGS`

The package can be assembled for an independent cryptographic specialist. Close the two LOW findings and freeze a remediated production image/evidence custody before formal laboratory submission.

## Implementation Package

- [x] Reviewed commit recorded: `1061cfcec9fb1fc78b2d2609ea7f283157842791`.
- [x] Reviewed CSPRNG source SHA-256 recorded: `53ecf20c1690b3e240f00d8df611b7bc57f413aba6434236ed72eb4ac9b74d30`.
- [x] Relevant source-file hashes recorded.
- [x] Target framework, SDK, runtime, host OS, and crypto dependencies recorded.
- [x] Production implementation source identified.
- [x] Qualification generator references the production application assembly and verifies the source hash.
- [ ] Rebuilt remediated production image digest recorded.
- [ ] Docker base images pinned by digest.
- [ ] SBOM and build provenance attestation bound to the image and source commit.

## Standards and Design

- [x] Fresh SP 800-90A Rev. 1 conformance matrix created.
- [x] SP 800-90B entropy boundary explicitly separated from application byte-length checks.
- [x] Final SP 800-90C assessment recorded as `SP800_90C_CLASSIFICATION_INSUFFICIENT_EVIDENCE`.
- [x] HMAC_DRBG state transitions re-derived from source.
- [x] Generate and reseed-counter limits independently reviewed.
- [x] Entropy, nonce, reseed, personalization, and immediate-reseed behavior documented.
- [x] Prediction resistance explicitly not claimed.
- [x] Bounded sampling, Keno/Matrix, and Pick transformations reviewed.
- [ ] External entropy/module evidence obtained for formal SP 800-90B/90C claims.

## Testing Evidence

- [x] Traceable NIST CAVS 14.3 HMAC_DRBG SHA-256 PR=False COUNT=0 vector passes.
- [x] Deterministic regression vectors pass.
- [x] Runtime-envelope boundary tests pass.
- [x] Unbiased sampler tests pass.
- [x] Internal provider contract and evidence tests pass.
- [x] Canonical invocation, same-draw concurrency, restart recovery, and no-fallback tests pass.
- [x] Migration 119 and full local migration validation pass.
- [x] Historical 1.2B campaign integrity passes.
- [x] 1.3B targeted regression and its original anomaly remain distinct.
- [ ] External reviewer decides whether additional official vectors are needed for any profile beyond SHA-256/256.
- [ ] External reviewer decides whether a fresh large statistical campaign is required for the final image.

## Historical Traceability

- [x] Original pre-remediation source hash retained.
- [x] Five CSPRNG-1.3A blocked-review artifacts retained unchanged.
- [x] F001/F002 HIGH remediation history retained.
- [x] New source hash and targeted requalification retained.
- [x] CSPRNG-1.2B evidence remains associated only with `0c2639...d46`.
- [x] Pick `p=0.009775221021193757` result remains identifiable.
- [x] Independent 50,000-sample Pick follow-up remains separately identifiable.
- [x] Five historical samples, 29 execution identities, and 22 anomaly entries remain represented.

## Claims and Findings

- [x] Fresh claims register created with permitted and prohibited claims.
- [x] Fresh findings register created.
- [x] CRITICAL findings: 0.
- [x] HIGH findings: 0.
- [x] MEDIUM findings: 0.
- [ ] LOW F001 closed: terminal session failure and replaced-state zeroization.
- [ ] LOW F002 closed: durable canceled-attempt evidence.
- [x] No NIST, CAVP, CMVP, laboratory, independent-audit, or regulator certification claim is made.
- [x] Managed-memory physical erasure limitation is explicit.

## Authority and Evidence

- [x] One manifest-bound provider executes with no silent fallback.
- [x] Internal CSPRNG, Official Results, and Manual Certified providers remain isolated.
- [x] Draw, manifest, provider, configuration, outcome, certificate, and signing-key bindings are documented.
- [x] New evidence omits secret-derived `SeedIdentifier`.
- [x] Non-secret execution provenance preserves auditability.
- [x] Raw entropy, nonce, reseed material, Key, V, and DRBG state are not persisted.
- [x] Qualification generator is non-production and no raw-byte endpoint exists.

## Evidence Custody

- [x] Git-tracked manifests contain source, sample, execution, and artifact hashes.
- [x] Multi-GiB raw evidence remains excluded from Git.
- [x] Current local evidence size and limitation are documented.
- [ ] Five raw samples transferred to immutable object storage.
- [ ] All 29 execution directories, logs, sidecars, and manifests transferred.
- [ ] Anomaly register and amendment lineage transferred.
- [ ] 1.3A, 1.3B, and 1.3C reports transferred with retention lock.
- [ ] Independent post-transfer hash verification and custody receipt recorded.

## External Submission Recommendation

1. Complete a narrow CSPRNG-1.3D for the two LOW findings without changing successful DRBG output semantics.
2. Re-run focused vectors, envelope, provider, cancellation, concurrency, and recovery QA.
3. Build and attest a digest-pinned production image from the final commit.
4. Transfer raw and tracked evidence into immutable long-term custody.
5. Submit source, image, matrix, threat model, claims, findings, tests, statistical evidence, anomaly history, and entropy-boundary statement to an independent cryptographic specialist.
6. Let the specialist or laboratory define any additional vectors, statistical reruns, entropy evidence, and formal validation scope.

Current status is suitable for independent review preparation, not for a claim of external certification.
