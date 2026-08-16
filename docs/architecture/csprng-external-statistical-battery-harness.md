# CSPRNG External Statistical Battery Harness

Status: **CSPRNG-1.2A HARNESS QUALIFICATION**. A successful smoke run is not external statistical qualification, independent cryptographic review, NIST certification, or laboratory certification.

## Objective And System Under Test

This harness prepares independent statistical testing of Mosera's production `INTERNAL_CSPRNG` byte generator. The unchanged system under test is `HmacDrbgRuntime` in `CertifiedCsprngRuntimeServices.cs`:

- HMAC_DRBG with SHA-256 and 256-bit security strength;
- 48 bytes of operating-system entropy and a 32-byte operating-system nonce;
- sample-bound personalization for qualification stream separation;
- an immediate reseed with 48 fresh operating-system entropy bytes;
- one isolated session per immutable sample;
- session and input-material zeroization.

The canonical qualified implementation SHA-256 is:

`0c2639d958dd916e0f6d56168ece697c6cff6b2fd0c3415368613425706c8d46`

Generation fails before producing a sample when this fingerprint differs. The qualification console references the real `GameEngine.Application` assembly; it does not contain another DRBG implementation and does not expose an API.

## Isolation Architecture

```text
qualified Game Engine HmacDrbgRuntime
  -> qualification-only .NET console
  -> immutable raw sample.bin + cryptographic manifest
  -> network-disabled qualification container invocation
  -> preserved suite stdout/stderr and native NIST result archive
```

PractRand, dieharder, and NIST STS exist only in `scripts/qualification/csprng/external-batteries`. They are absent from all production images and project dependencies. The battery container receives one read-only sample mount, one result mount, no network, and no credentials.

## Reproducible Tool Environment

The image uses digest-pinned `debian:12.11-slim` and installs/builds:

| Tool | Pinned identity | Input path |
| --- | --- | --- |
| PractRand | 0.96 archive, SHA-256 `e4caf7fda98b2c597bbda3b576753cf5a0f6047aab837c82be370ab798a672e1` | raw bytes through `RNG_test stdin` |
| dieharder | Debian package `3.31.1.4-1` | raw file generator `201` |
| NIST SP 800-22 STS | 2.1.2 archive, SHA-256 `0238d2f1d26e120e3cc748ed2d4c674cdc636de37fc4027c76cc2a394fff9157` | binary file input |

The NIST source is the [official NIST STS download](https://csrc.nist.gov/Projects/Random-Bit-Generation/Documentation-and-Software). It is compiled with its supplied makefile. Container inventory records the Debian release, compiler/runtime-visible tool versions, archive hashes, and TestU01 status. The generator manifest separately records the .NET runtime, generator assembly hash, Git commit, and qualified source hash.

TestU01 is intentionally not installed in 1.2A. Debian 12 does not provide a clean pinned binary package in the configured repository, while source integration adds a fourth build chain and is not required by the completion gate. It remains an optional 1.2B extension after the three mandatory suites are stable.

## Generation And Sample Identity

Generate multiple independent streams with distinct caller-assigned sample IDs:

```bash
npm run csprng:external:generate -- --sample-id campaign-a-stream-001 --bytes 1073741824
npm run csprng:external:generate -- --sample-id campaign-a-stream-002 --bytes 1073741824
```

Output is unmodified `application/octet-stream`: no formatting, reduction, whitening, compression, or lottery-number mapping. Generation is chunked, so stream size may progress from hundreds of MiB through multiple GiB without retaining the full sample in memory.

Each identity creates a root claim with create-new semantics. Existing claims, sample files, manifests, or result files are never overwritten. Interrupted or failed generation leaves its identity consumed and writes `manifest.failed.json`; a follow-up must use a new identity. Raw entropy, nonce material, reseed material, DRBG keys, and DRBG state are never written. A public hash of personalization records domain separation without disclosing secret initialization material.

## Evidence Manifest

Every completed sample directory contains:

- `sample.bin`: canonical raw bytes, read-only where supported;
- `manifest.initial.json`: immutable generation-start evidence;
- `manifest.json`: completed payload and payload SHA-256;
- `manifest.json.sha256`: SHA-256 of the serialized manifest;
- `runs/<run-id>/execution.json`: immutable battery invocation metadata;
- per-tool `.stdout.log` and `.stderr.log` files;
- `nist-sts-output.tar.gz`: native detailed NIST output for the selected run.

The completed payload records package/sample/execution identity, UTC timestamps, algorithm, source fingerprint and commit, byte/bit counts, raw sample SHA-256, invocation, assembly/.NET identity, host identity, intended suites, evidence path, initialization provenance, and completion status.

## Operations

```bash
npm run csprng:external:build
npm run csprng:external:inventory
npm run csprng:external:generate -- --sample-id <unique-id> --bytes <count>
npm run csprng:external:verify -- --sample <sample-directory>
npm run csprng:external:show -- --sample <sample-directory>
npm run csprng:external:smoke -- --sample <sample-directory>
```

The smoke path uses one 1 MiB sample, a short PractRand range, one dieharder test, and the NIST Frequency test over one 1,000,000-bit sequence. Every smoke artifact is labeled `NON_QUALIFICATION_SMOKE_TEST`; no p-value is promoted into a qualification verdict.

For the 1.2B NIST campaign, concatenate or stage independently identified samples only according to a recorded campaign plan. Use at least 1,000,000 bits per sequence and enough independent sequences for second-level pass-proportion and p-value-uniformity analysis. Preserve individual p-values, proportions, confidence bounds, alpha, and any excluded-test rationale rather than reducing output to one boolean.

## Retention And Failure Discipline

Large binaries remain outside Git under ignored `.qa/csprng-1.2a/evidence` during local work. A formal campaign must place the complete sample directories in access-controlled immutable object storage or WORM-capable evidence storage, keyed by sample SHA-256. Git retains the generator, manifest schema, commands, pinned tool environment, QA, and policy; the campaign evidence repository retains raw bytes and outputs.

Never rerun until green and discard a result. An anomaly retains its sample hash, suite/test, statistic or p-value, command, tool version, and full raw output. Investigation and reruns receive new evidence identities. Persistent significant anomalies block 1.2B pending review; isolated failures are assessed against alpha, hypothesis count, expected false positives, recurrence, and cross-suite behavior.

## Qualification Boundaries And 1.2B Gate

- **Internal Mosera qualification:** completed before this package.
- **Independent external statistical batteries:** harness prepared here; full campaign is CSPRNG-1.2B.
- **Independent cryptographic review:** not completed.
- **External laboratory certification:** not completed.

CSPRNG-1.2B may begin only after the image builds from pinned sources, inventory is captured, at least two independent sample identities verify, all three mandatory smoke invocations preserve outputs, evidence storage ownership/retention is approved, and the campaign plan fixes sample counts, progressive PractRand sizes, NIST sequence parameters, alpha/multiple-testing interpretation, anomaly handling, and reviewer sign-off.
