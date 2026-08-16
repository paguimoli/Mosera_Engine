# CSPRNG-1.2B Independent Statistical Qualification Campaign

## Decision

`CSPRNG_1_2B_PASS`

Mosera's unchanged qualified internal CSPRNG passed the defined independent external statistical qualification campaign. This is statistical qualification evidence, not NIST, laboratory, regulator, or independent cryptographic certification.

## Campaign Identity

- Campaign: `csprng-1.2b-20260816T185106Z-7eda4e0`
- Frozen source commit: `7eda4e0e0d4225bbf098ef3b9587fcd7df5345c9`
- Campaign start: `2026-08-16T18:51:06Z`
- Evidence root: `.qa/csprng-1.2b/csprng-1.2b-20260816T185106Z-7eda4e0`
- Campaign metadata: `docs/qa/csprng-1.2b-campaign-metadata.json`
- Append-only anomaly register: `docs/qa/csprng-1.2b-anomaly-register.json`
- Evidence inventory: `docs/qa/csprng-1.2b-evidence-inventory.json`

## System Under Test

The sample generator references and compiles the production Game Engine assembly containing `CertifiedCsprngRuntimeServices.cs`; it does not contain a copied DRBG. The qualified source SHA-256 remained:

`0c2639d958dd916e0f6d56168ece697c6cff6b2fd0c3415368613425706c8d46`

The qualified configuration is HMAC-DRBG with SHA-256, 256-bit security strength, 48-byte OS entropy, 32-byte OS nonce, draw-bound personalization, immediate 48-byte reseed, isolated per-sample session, and zeroization. No raw entropy, nonce, reseed material, or internal DRBG state was persisted.

## Frozen Environment

| Component | Frozen value |
| --- | --- |
| Game Engine / generator target | `net10.0` |
| .NET SDK | `10.0.301`, commit `96856fd726` |
| .NET runtime | `10.0.9`, commit `901ca94124` |
| Host | macOS 26.6/26.6.1, x64 |
| Production Game Engine image | `lottery-app-game-engine@sha256:5117947f85f768bd6d84690b1a5b1cc95ec298a62b38ee5a7bda17d3917e1a29` |
| Qualification image | `mosera/csprng-external-batteries@sha256:f3422c599d851ea93444d23a40b11466d75968052bea96eff37a8e57b66d5d81` |
| Base Linux image | `debian:12.11-slim@sha256:b1a741487078b369e78119849663d7f1a5341ef2768798f7b7406c4240f86aef` |
| Compiler | `g++ (Debian 12.2.0-14+deb12u1) 12.2.0` |
| PractRand | 0.96, source SHA-256 `e4caf7fda98b2c597bbda3b576753cf5a0f6047aab837c82be370ab798a672e1` |
| dieharder | binary 3.31.1, Debian package 3.31.1.4-1 |
| NIST STS | 2.1.2, source SHA-256 `0238d2f1d26e120e3cc748ed2d4c674cdc636de37fc4027c76cc2a394fff9157` |

The nine append-only amendment records disclose the streaming-verifier correction, invalid NIST prompt invocations, targeted dieharder selector support, sandbox permission failures, chronology correction, and no-rewind investigations. None changed the qualified implementation, generator semantics, qualification image, or prior evidence.

## Independent Streams

| Stream | Bytes | SHA-256 | Purpose |
| --- | ---: | --- | --- |
| stream 01 | 2,147,483,648 | `74c1e63f9684e52635500fb67423f6939c2495c6ce9dbcd973c1777e58f5cdb1` | PractRand multi-GiB and full dieharder |
| stream 02 | 1,073,741,824 | `f723f6fbeaaef9c5b8fc3784b840d8364deacf98531a6f8024fece77cbf12a18` | PractRand and full dieharder |
| stream 03 | 1,073,741,824 | `c3f7a453fb3f53d22173c825c68fb749946fbba352e4430424786efc95c590d5` | PractRand, full dieharder, and NIST |
| stream 04 | 536,870,912 | `c2fc0e0587459b389c62bb946cbcb05e33b2af6eac00c0c532c38946273f2ccf` | PractRand, NIST, and independent anomaly follow-up |
| stream 05 | 17,179,869,184 | `a0bf646234ca9f7cb8e09aa60681e835afe1db4e1b6879037f53ef202b3d121f` | No-rewind investigation for high-consumption dieharder tests |

All five streams have distinct sample IDs, initialization events, personalization provenance hashes, and output hashes. Their total raw size is 22,011,707,392 bytes (20.5 GiB).

The manifest field `qualificationPackageId` remains `CSPRNG-1.2A` because 1.2B intentionally reused the closed 1.2A generator and manifest schema. The 1.2B campaign identity is bound by the containing evidence path and every campaign execution record.

## PractRand Methodology and Results

PractRand 0.96 consumed raw bytes with `RNG_test stdin -tlmin 256MB` and per-stream maximums of 512 MiB, 1 GiB, or 2 GiB. Network access was disabled and stdout, stderr, command, runtime, image digest, sample identity, and artifact hashes were preserved.

| Stream | Checkpoints | Final result |
| --- | --- | --- |
| 01 | 256 MiB, 512 MiB, 1 GiB, 2 GiB | 246 results at 2 GiB; no anomalies |
| 02 | 256 MiB, 512 MiB, 1 GiB | 231 results at 1 GiB; no anomalies |
| 03 | 256 MiB, 512 MiB, 1 GiB | 231 results at 1 GiB; no anomalies |
| 04 | 256 MiB, 512 MiB | 216 results at 512 MiB; no anomalies |

No unusual, suspicious, failure, or recurrent PractRand result was reported.

## dieharder Methodology and Results

Three independent full practical batteries used `dieharder -a -g 201 -f /input/sample.bin`. Each reported 114 hypotheses, for 342 total. All full runs exited successfully. There were 329 `PASSED`, 13 `WEAK`, and zero `FAILED` results in the three original full batteries.

At dieharder's approximately 1% two-tailed weak region, the nominal expectation is 3.42 weak results. An independent-binomial approximation gives probability 0.0000533 for at least 13; this is notable, but the suite hypotheses are correlated and the file generator disclosed repeated rewinds for high-consumption tests. The count was therefore investigated rather than dismissed or treated as an exact suite-level p-value.

All affected families/tuples were evaluated against independent stream 04. Most did not recur. Serial tuple 2 produced one additional `WEAK` value on stream 04, while the same tuple passed on streams 01 through 03; two subsequent selector commands repeated the same stream-04 bytes and were retained but not treated as independent evidence.

Three rewind-sensitive patterns required a larger independent stream:

| Test | Prior evidence | 16 GiB no-rewind result | Disposition |
| --- | --- | --- | --- |
| RGB lagged sum lag 23 | `WEAK` on streams 01 and 02 | `p=0.51120759`, `PASSED`, zero stderr | finite-file reuse artifact, not reproduced |
| RGB lagged sum lag 31 | `WEAK` on stream 02; `FAILED p=0.00000039` on stream 04 with 23 rewinds | `p=0.71402512`, `PASSED`, zero stderr | finite-file reuse artifact, not reproduced |
| Marsaglia-Tsang GCD | `WEAK` on streams 03 and 04; stream 04 rewound 14 times | `p=0.93311253` and `p=0.66244020`, both `PASSED`, zero stderr | finite-file reuse artifact, not reproduced |

The original weak and failed outputs remain preserved. No rerun replaced prior evidence, and every follow-up used a new execution ID.

## NIST SP 800-22 Methodology

Two independent valid campaigns used NIST STS 2.1.2 with:

- 100 sequences per campaign;
- 1,000,000 bits per sequence;
- first-level significance `alpha=0.01`;
- all 15 test families enabled;
- Block Frequency block size 128;
- Non-overlapping Template length 9;
- Overlapping Template length 9;
- Approximate Entropy block length 10;
- Serial block length 16;
- Linear Complexity block length 500;
- binary input mode.

The complete `experiments/AlgorithmTesting` directory was archived for each valid execution, in addition to `finalAnalysisReport.txt`, stdout, stderr, invocation, and hashes. Random Excursions tests were evaluated only on sequences satisfying their cycle-count applicability requirement.

## NIST Results and Second-Level Analysis

Each valid report contained 188 second-level rows.

| Stream | Applicable first-level tests | First-level failures | Uniformity minimum | Proportion result |
| --- | ---: | ---: | ---: | --- |
| 03 | 17,864 | 197 (1.10%) | 0.004301 | two isolated 95/100 Non-overlapping Template rows below 96/100 |
| 04 | 17,916 | 160 (0.89%) | 0.000569 | all rows at or above required minimum |

The first-level expectation at `alpha=0.01` was approximately 178.64 and 179.16 failures respectively. For ordinary 100-sequence rows the three-sigma minimum was 96/100. Random Excursions rows had 64 or 66 applicable sequences, with report minima 60/64 and 62/66.

Stream 03 had two 95/100 proportion failures among its 148 Non-overlapping Template rows, at ordinals 49 and 122. Under an independent binomial approximation, one such row has probability approximately 0.003432 and two or more among 148 rows has probability approximately 0.0924; template rows are not strictly independent. Both exact ordinals passed at 99/100 on independent stream 04, so the failures were preserved as isolated, non-persistent second-level anomalies rather than hidden or treated as a recurring defect.

All second-level p-value uniformity values exceeded NIST's 0.0001 report threshold. Low but accepted values and the two stream-03 proportion failures are retained in the anomaly register. The two initially invalid prompt-loop invocations did not reach valid statistical execution; their multi-GiB logs, interruption records, and replacement lineage are preserved.

## Cross-Battery Interpretation

PractRand reported no anomaly across four independent streams through 2 GiB. NIST stream 04 met every second-level criterion, while the two stream-03 proportion failures did not recur at matching template ordinals on stream 04. dieharder's isolated weak values did not recur at matching tuples on fresh data, and its recurrent high-consumption patterns disappeared when exact tests consumed distinct bytes without rewinding. There is no unresolved persistent cross-sample or cross-battery defect signal.

This conclusion does not use rerun-until-green reasoning. The failed lag-31 evidence remains part of the campaign; the decisive distinction is that the failure occurred after 23 finite-file rewinds and was not reproduced by the separately identified exact test on 16 GiB of distinct bytes.

## Evidence Integrity and Storage

The campaign preserves 29 execution identities:

- 24 completed executions;
- 3 Docker-permission failures preserved before battery startup;
- 2 invalid NIST prompt-loop executions preserved with interruption manifests.

The local evidence directory contains 32,244,070,437 bytes. Sample and execution manifests are create-only, hash-linked, and read-only after completion. The closeout QA recomputes every raw sample hash and every registered artifact hash, validates sidecars and payload hashes, checks uniqueness, validates anomaly references, and reconciles the inventory size.

Multi-GiB binaries are excluded from Git. Production-grade WORM/object retention is not configured in this repository; transferring the complete directory by hash before independent laboratory or regulator submission remains mandatory.

## Production Isolation

No production CSPRNG, entropy, nonce, reseed, personalization, draw, outcome, settlement, ledger, wallet, completion, commission, rebate, provider-selection, API, Docker runtime, or service code changed. The qualification image ran with `--network none`. Existing unrelated worktree changes in local runtime inventory and integrated-runtime QA were left untouched.

## Limitations and Non-Claims

- TestU01 was not added: `TESTU01_DEFERRED_NONBLOCKER`.
- dieharder finite-file full batteries necessarily rewound inputs; exact no-rewind investigations were added only for recurrent affected tests.
- Evidence remains local rather than in external WORM retention.
- Statistical testing cannot prove cryptographic security or implementation correctness.
- This package is not NIST certification, independent expert cryptographic review, laboratory certification, or regulator approval.

## Conclusion and Next Gate

The unchanged Mosera internal HMAC-DRBG implementation passed the defined PractRand, dieharder, and NIST SP 800-22 external statistical campaign with all notable evidence preserved and no unresolved recurrent anomaly.

The recommended next gate is independent cryptographic design/implementation review followed by production-grade WORM evidence retention and accredited laboratory/regulator engagement where required.

Recommended commit message after review:

`test(csprng): record independent statistical qualification campaign`
