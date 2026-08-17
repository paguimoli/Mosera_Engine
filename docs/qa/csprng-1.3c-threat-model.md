# CSPRNG-1.3C Threat Model

## Scope

This threat model covers the remediated Internal CSPRNG source at commit `1061cfcec9fb1fc78b2d2609ea7f283157842791`, source hash `53ecf20c1690b3e240f00d8df611b7bc57f413aba6434236ed72eb4ac9b74d30`. It covers OS entropy acquisition, HMAC_DRBG session state, unbiased number transformation, canonical provider execution, immutable evidence, outcome certification, and recovery.

The Game Engine process, .NET runtime, operating system, kernel entropy implementation, deployment image, and signing-key provider form successive trust boundaries. The database is not trusted with raw entropy or DRBG state. Players, operators, and request clients are outside the cryptographic authority boundary.

## Assets

- Unpredictability and integrity of authoritative draw outcomes.
- Entropy, nonce, reseed material, Key, V, and temporary random buffers.
- Exact provider, configuration, game definition, draw, execution, and certificate bindings.
- Durable idempotency and exactly-once authority.
- Immutable provider, outcome, certificate, recovery, and settlement evidence.
- Accurate qualification and certification claims.

## Threat Assessment

| Threat actor / condition | Asset and attack | Controls | Residual risk | Ownership |
| --- | --- | --- | --- | --- |
| Malicious player | Predict, bias, replay, or substitute a draw through request parameters | Server-side manifest/provider resolution; no client-selected provider; OS entropy; HMAC_DRBG; unbiased sampling; exact draw/certificate checks | Cannot address compromised host or signing key from client controls | Internal application; platform dependencies external |
| Malicious operator | Select a favorable provider, rerun a draw, or substitute a result | Immutable manifest binding; governed activation; draw lock; durable claim; persisted-result retry; no fallback; append-only evidence | A fully privileged host/operator compromise remains capable of process tampering | Internal governance and platform security |
| Privileged insider | Read process state, alter deployment, or misuse signing authority | Least privilege, separate signing provider/version/key binding, immutable evidence, audit, no secrets in DB | Debug/process privilege can expose live state; release controls must bind image and source | Platform security and operational governance |
| Compromised application account | Invoke internal routes or repeat requests | Canonical draw lifecycle fence, exact manifest activation, idempotency, scope lock, certificate verification | Authorization controls outside this review remain required | Application security |
| Compromised database | Alter provider evidence, rebind draw/result, or recover secret material | No raw secrets; hashes and exact references; append-only triggers; unique claims; replay verification; certificate binding | Database superuser can tamper below application triggers unless external DB audit/backup controls detect it | Database/platform security |
| Compromised Game Engine process | Read Key/V or force arbitrary output | Per-draw isolation and short state lifetime limit blast radius; no persistence; immutable downstream binding | Process compromise defeats generation integrity for active draws | Platform security; outside application-only assurance |
| Compromised host/kernel | Supply weak entropy, inspect memory, or alter crypto implementation | Fail-closed API handling, per-draw reacquisition, image/runtime evidence planned | Host/kernel compromise defeats entropy and runtime assumptions | External platform boundary |
| Replay attacker | Reuse idempotency key, old evidence, stale certificate, or prior draw result | Canonical request hash conflict detection; exact draw/manifest/provider/config/hash/signing-key checks; persisted result reuse | Operational cancellation evidence gap can reduce diagnosis, not authorize replay | Internal application |
| Concurrency attacker | Trigger simultaneous same-draw generations or duplicate certificates | Advisory execution lock, durable unique claim, one generated evidence row, one authoritative binding | Generated loser material may exist transiently but cannot become authority | Internal application |
| Misconfiguration | Enable wrong provider/configuration, unsafe evidence contract, or test tooling | Configuration version 2 disabled by migration; activation guardrails; provider-category dispatch; production DI excludes test generators | Current local image is stale; release packaging must be frozen | Internal governance and release engineering |
| Future developer misuse | Call generic DRBG directly, select unused profiles, reuse failed session, or bypass wrapper | Input validation; internal Key/V; canonical provider authority; production profile fixed to SHA-256/256 | LOW F001: reusable session is not terminal on every state-transition exception; generic profile breadth adds review surface | Game Engine cryptographic runtime |
| Entropy failure | OS source unavailable, returns error, or host source is weak | Platform API wrappers fail closed; health checks; three fresh per-draw requests | API success does not prove SP 800-90B min-entropy | Platform and external assessor |
| State disclosure | Read one draw session before/after Generate | Per-draw state, immediate reseed, post-Generate update, short lifetime, best-effort zeroization | Current draw can be compromised; managed-memory copies and dumps may survive | Internal runtime plus platform hardening |
| Supply-chain/runtime compromise | Replace .NET crypto, base image, SDK, or production assembly | Source hashes, build tests, image digest capture, SBOM/attestation recommendation | Docker base tags are mutable and no remediated image is frozen | Release engineering and platform security |
| Evidence-custody failure | Lose, replace, or selectively present statistical samples and anomalies | Git-tracked hashes/manifests, append-only anomaly identities, read-only local evidence | Local evidence is not WORM and may be lost or altered by a privileged local user | Qualification governance and external storage |

## State and Failure Analysis

### Session compromise

- Before Generate: future bytes for that session can be predicted by the attacker.
- After Generate: post-generation Update limits backtracking subject to HMAC security and memory-copy realities.
- After immediate reseed: persisted evidence does not expose either entropy input.
- Across draws: no shared Key/V exists, so ordinary single-session disclosure does not expose another draw.

### Crash and cancellation

- Before durable generation: retry starts a new isolated session under the same durable claim and lock.
- After durable generation: retry returns existing evidence and does not regenerate.
- Before certificate binding: generated evidence remains non-authoritative.
- After certificate binding: exact hashes and signing provider/version/key are required for publication.
- Cancellation destroys the session and commits no result, but may leave no explicit canceled attempt row (F002).

### Secret custody

Entropy, nonce, reseed bytes, seed material, Key, V, and temporary sampler buffers are not database columns or provider evidence fields. The application applies best-effort zeroization. Physical erasure is not guaranteed in a managed runtime. Crash dumps, debug access, swap, HMAC implementation internals, and kernel compromise require deployment controls.

## Residual Risk Decision

No CRITICAL, HIGH, or MEDIUM threat remains in the reviewed application path. F001 and F002 are LOW because the canonical authority fails closed and accepts no unsafe result, but both should be closed before external review. SP 800-90B, final SP 800-90C classification, immutable evidence custody, production image attestation, and host memory hardening remain external or release-boundary dependencies.
