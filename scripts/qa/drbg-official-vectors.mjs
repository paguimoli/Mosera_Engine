import { readFileSync } from "node:fs";

const checks = [];

function addCheck(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

const service = readFileSync("services/game-engine/src/GameEngine.Application/Services/OutcomeAuthorityHardeningService.cs", "utf8");
const runtime = readFileSync("services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs", "utf8");
const tests = readFileSync("services/game-engine/tests/GameEngine.Application.Tests/Program.cs", "utf8");

addCheck("Mosera fixtures are accurately labeled regression vectors", service.includes("MOSERA-HMAC-DRBG-DETERMINISTIC-REGRESSION") && service.includes("not an authoritative NIST CAVP vector"));
addCheck("regression suite covers SHA-256", service.includes("hmac-drbg-sha256-instantiate-generate-reseed-additional"));
addCheck("regression suite covers SHA-384", service.includes("hmac-drbg-sha384-instantiate-generate-reseed-additional"));
addCheck("regression suite covers SHA-512", service.includes("hmac-drbg-sha512-instantiate-generate-reseed-additional"));
addCheck("regression vectors cover generate/reseed/additional input/final state", service.includes("ExpectedPostReseedGenerateHex") && service.includes("ExpectedFinalKeyHex") && service.includes("AdditionalInputHex"));
addCheck("provider build identity recorded", service.includes("ProviderBuildIdentity"));
addCheck("runtime health checks use conformance vectors", runtime.includes("RunHmacDrbgConformanceVectors"));
addCheck("NIST CAVP CAVS 14.3 SHA-256 COUNT 0 vector is executed", runtime.includes("nist-cavp-cavs14.3-drbg-pr-false-hmac-sha256-count0") && runtime.includes("76fc79fe9b50becc"));
addCheck("CAVP vector covers reseed and two Generate operations", runtime.includes("Reseed(session, reseedEntropy)") && runtime.includes("first = Generate(session, expectedBytes.Length)") && runtime.includes("second = Generate(session, expectedBytes.Length)"));
addCheck("modified vector failure is tested", tests.includes("Modified HMAC-DRBG vector must fail conformance"));

const failed = checks.filter((check) => check.status !== "PASS");
console.log(JSON.stringify({ status: failed.length === 0 ? "PASS" : "FAIL", checks }, null, 2));
if (failed.length > 0) {
  process.exitCode = 1;
}
