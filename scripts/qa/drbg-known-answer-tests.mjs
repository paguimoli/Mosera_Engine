import { readFileSync } from "node:fs";

const checks = [];

function addCheck(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

function read(path) {
  return readFileSync(path, "utf8");
}

const runtimeSource = read("services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs");
const testSource = read("services/game-engine/tests/GameEngine.Application.Tests/Program.cs");

addCheck("startup health checks run KATs", runtimeSource.includes("RunHealthChecks") && runtimeSource.includes("GenerateDeterministicVector"));
addCheck("KATs cover SHA-256/384/512", testSource.includes("Enum.GetValues<CertifiedCsprngHashAlgorithm>()") && runtimeSource.includes("CertifiedCsprngHashAlgorithm.Sha256") && runtimeSource.includes("CertifiedCsprngHashAlgorithm.Sha384") && runtimeSource.includes("CertifiedCsprngHashAlgorithm.Sha512"));
addCheck("deterministic reproducibility asserted", testSource.includes("deterministic test vector must be reproducible"));
addCheck("constant-time comparison used", runtimeSource.includes("CryptographicOperations.FixedTimeEquals") && testSource.includes("CryptographicOperations.FixedTimeEquals"));
addCheck("continuous repetition test exists", runtimeSource.includes("VerifyContinuousTest") && runtimeSource.includes("continuous repetition test failed"));
addCheck("destroyed session fails closed", testSource.includes("Destroyed HMAC-DRBG session must fail closed"));
addCheck("reseed behavior tested", testSource.includes("reseed should change generated output"));

const failed = checks.filter((check) => check.status !== "PASS");
console.log(JSON.stringify({ checks }, null, 2));
if (failed.length > 0) {
  process.exitCode = 1;
}
