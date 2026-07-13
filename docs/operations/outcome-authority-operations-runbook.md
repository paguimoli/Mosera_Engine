# Outcome Authority Operations Runbook

P0-007.13 keeps production Outcome Authority disabled. These procedures define fail-closed operations evidence and escalation paths only.

## Emergency Disable

- Set the Outcome Authority activation guardrail to disabled.
- Record operator, reason, affected provider, and evidence hash.
- Confirm readiness reports show production activation blocked.
- Do not supersede outcomes without dual approval.

## Failed Entropy Or DRBG Health

- Stop outcome generation attempts for the affected provider.
- Verify the configured entropy provider id/version matches the runtime OS provider.
- Run DRBG conformance QA and capture evidence.
- Keep production readiness blocked until conformance and entropy readiness pass.

## Nonce Conflict

- Fail closed for the affected request scope.
- Preserve nonce conflict evidence and runtime request idempotency records.
- Resume only after duplicate/reused nonce scope is explained and corrected.

## Seed Compromise

- Treat all affected provider sessions as disputed.
- Disable affected provider configuration.
- Preserve reveal/custody evidence.
- Rotate seeds only through an approved future custody process.

## Signing-Key Compromise

- Disable affected signing provider.
- Mark affected signatures as requiring verification review.
- Preserve chain references and do not rewrite certificates.
- Rotate keys only after KMS/HSM custody is commissioned.

## Official Result Conflict

- Fail closed on conflicting external official result evidence.
- Record source, schema mapping, signature validation result, and conflict hash.
- Require supersession workflow before replacement evidence is accepted.

## Physical Draw Dispute

- Preserve witness, equipment, custody, and draw event evidence.
- Mark outcome custody as Disputed where applicable.
- Require dual approval for void, replay, or supersession controls.

## Outcome Supersession

- Never edit original outcome/certificate records.
- Create supersession evidence referencing the original certificate.
- Preserve chain roots, signatures, operator, reason, and approval metadata.

## Crash Recovery

- Restart Game Engine.
- Verify durable idempotency returns the existing request state.
- Confirm advisory locks are released.
- Confirm fresh DRBG session evidence before any new dry-run generation.
- Ensure no duplicate outcomes, certificates, or receipts were created.

## Rollback Detection

- Compare startup watermark sequence and previous chain root.
- Fail closed on sequence regression, chain mismatch, or missing evidence.
- Treat restored snapshots as unsafe until reconciliation evidence is captured.

## Activation Rehearsal

- Run all P0-005 and P0-007 QA.
- Confirm provider, entropy, DRBG, signing, statistical, recovery, and custody sections are present.
- Confirm production activation remains disabled.
- Confirm no test/simulation provider is production eligible.
