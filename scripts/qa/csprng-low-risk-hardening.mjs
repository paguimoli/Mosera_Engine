import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const paths = {
  runtime: "services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs",
  provider: "services/game-engine/src/GameEngine.Application/Services/InternalCsprngOutcomeProvider.cs",
  tests: "services/game-engine/tests/GameEngine.Application.Tests/Program.cs",
};
const source = Object.fromEntries(
  Object.entries(paths).map(([name, path]) => [name, readFileSync(path, "utf8")]),
);
const checks = [];

function check(name, passed, evidence) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", evidence });
}

check(
  "F001 direct V replacement uses zeroing helper",
  source.runtime.includes("ReplaceWithHmac(session.HashAlgorithm, ref value, session.Key, value)"),
  paths.runtime,
);
check(
  "F001 Instantiate exception clears candidate Key and V",
  source.runtime.includes("CryptographicOperations.ZeroMemory(key);\n            CryptographicOperations.ZeroMemory(value);"),
  paths.runtime,
);
check(
  "F001 Generate terminal failure destroys session",
  source.runtime.includes("CryptographicOperations.ZeroMemory(output);\n            session.MarkDestroyed();"),
  paths.runtime,
);
check(
  "F001 Reseed terminal failure destroys session",
  source.runtime.includes("UpdateSession(session, seedMaterial)") &&
    source.runtime.includes("session.MarkDestroyed();\n            throw;"),
  paths.runtime,
);
check(
  "F001 rejected calls and exceptional lifecycle are tested",
  [
    "Rejected oversized Generate changed HMAC-DRBG state",
    "Rejected reseed changed HMAC-DRBG state",
    "Reseed-required rejection changed HMAC-DRBG state",
    "VerifyExceptionalSessionLifecycle",
    "Terminal HMAC-DRBG failure must invalidate the session",
  ].every((token) => source.tests.includes(token)),
  paths.tests,
);
check(
  "F002 cancellation uses existing retryable terminal attempt status",
  source.provider.includes("catch (OperationCanceledException cancellation)") &&
    source.provider.includes("OutcomeProviderExecutionStatus.RetryableFailure") &&
    source.provider.includes("OutcomeProviderFailureClassification.Retryable") &&
    source.provider.includes('"OPERATION_CANCELLED"'),
  paths.provider,
);
check(
  "F002 cancellation evidence uses bounded independent token",
  source.provider.includes("CancellationEvidenceTimeout = TimeSpan.FromSeconds(5)") &&
    source.provider.includes("new CancellationTokenSource(CancellationEvidenceTimeout)"),
  paths.provider,
);
check(
  "F002 durable authority wins cancellation race",
  source.provider.indexOf("FindGeneratedEvidenceAsync(", source.provider.indexOf("catch (OperationCanceledException cancellation)")) <
    source.provider.indexOf("CancelledAttempt(", source.provider.indexOf("catch (OperationCanceledException cancellation)")),
  paths.provider,
);
check(
  "F002 meaningful cancellation boundaries are tested",
  [
    "before entropy acquisition",
    "after entropy acquisition",
    "DrbgCancellationBoundary.Instantiate",
    "DrbgCancellationBoundary.Reseed",
    "after Generate before persistence",
    "during persistence",
    "after durable result persistence",
  ].every((token) => source.tests.includes(token)),
  paths.tests,
);
check(
  "F002 cancellation remains non-authoritative",
  source.tests.includes("repository.GeneratedEvidence.Count != 0") &&
    source.tests.includes("repository.AuthoritativeEvidence.Count != 0") &&
    !source.provider.slice(
      source.provider.indexOf("private static OutcomeProviderExecutionAttempt CancelledAttempt"),
      source.provider.indexOf("private static OutcomeProviderExecutionEvidence ToGeneratedAuthorityEvidence"),
    ).match(/ledger|wallet|settlement|certificate/i),
  `${paths.provider}; ${paths.tests}`,
);

const focusedRuntime = spawnSync(
  "dotnet",
  [
    "run",
    "--no-build",
    "--project",
    "services/game-engine/tests/GameEngine.Application.Tests/GameEngine.Application.Tests.csproj",
    "--no-restore",
    "--",
    "csprng-low-risk-hardening",
  ],
  { encoding: "utf8", timeout: 180_000 },
);
check(
  "focused .NET lifecycle and cancellation harness passes",
  focusedRuntime.status === 0 &&
    focusedRuntime.stdout.includes("CSPRNG-1.3D focused lifecycle and cancellation tests passed."),
  {
    status: focusedRuntime.status,
    stdout: focusedRuntime.stdout.trim(),
    stderr: focusedRuntime.stderr.trim(),
  },
);

const sourceSha256 = createHash("sha256").update(source.runtime).digest("hex");
const failures = checks.filter((item) => item.status === "FAIL");
console.log(JSON.stringify({
  status: failures.length === 0 ? "PASS" : "FAIL",
  candidateSourceSha256: sourceSha256,
  checks,
}, null, 2));

if (failures.length > 0) {
  process.exitCode = 1;
}
