import { readFileSync } from "node:fs";

const checks = [];

function addCheck(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

const service = readFileSync("services/game-engine/src/GameEngine.Application/Services/OutcomeAuthorityHardeningService.cs", "utf8");
const runtime = readFileSync("services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs", "utf8");
const tests = readFileSync("services/game-engine/tests/GameEngine.Application.Tests/Program.cs", "utf8");

addCheck("immutable HMAC-DRBG vector suite exists", service.includes("NIST-SP800-90A-REV1-HMAC-DRBG-CONFORMANCE"));
addCheck("vector suite covers SHA-256", service.includes("hmac-drbg-sha256-instantiate-generate-reseed-additional"));
addCheck("vector suite covers SHA-384", service.includes("hmac-drbg-sha384-instantiate-generate-reseed-additional"));
addCheck("vector suite covers SHA-512", service.includes("hmac-drbg-sha512-instantiate-generate-reseed-additional"));
addCheck("vectors cover generate/reseed/additional input/final state", service.includes("ExpectedPostReseedGenerateHex") && service.includes("ExpectedFinalKeyHex") && service.includes("AdditionalInputHex"));
addCheck("provider build identity recorded", service.includes("ProviderBuildIdentity"));
addCheck("runtime health checks use conformance vectors", runtime.includes("RunHmacDrbgConformanceVectors"));
addCheck("modified vector failure is tested", tests.includes("Modified HMAC-DRBG vector must fail conformance"));

const failed = checks.filter((check) => check.status !== "PASS");
console.log(JSON.stringify({ status: failed.length === 0 ? "PASS" : "FAIL", checks }, null, 2));
if (failed.length > 0) {
  process.exitCode = 1;
}
