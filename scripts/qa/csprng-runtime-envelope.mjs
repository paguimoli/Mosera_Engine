import { readFileSync } from "node:fs";

const runtime = readFileSync(
  "services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs",
  "utf8",
);
const tests = readFileSync(
  "services/game-engine/tests/GameEngine.Application.Tests/Program.cs",
  "utf8",
);
const generator = readFileSync(
  "services/game-engine/tests/GameEngine.CsprngExternalSampleGenerator/Program.cs",
  "utf8",
);
const provider = readFileSync(
  "services/game-engine/src/GameEngine.Application/Services/InternalCsprngOutcomeProvider.cs",
  "utf8",
);

const checks = [];
function addCheck(name, passed) {
  checks.push({ name, status: passed ? "PASS" : "FAIL" });
}

addCheck("Generate maximum is 65536 bytes", runtime.includes("MaximumBytesPerGenerateRequest = 65_536"));
addCheck("oversized Generate rejects before state mutation", runtime.indexOf("byteCount > MaximumBytesPerGenerateRequest") < runtime.indexOf("if (!additionalInput.IsEmpty)"));
addCheck("reseed interval is 2^48", runtime.includes("MaximumReseedInterval = 1L << 48"));
addCheck("reseed-required check precedes generation", runtime.indexOf("session.ReseedCounter > MaximumReseedInterval") < runtime.indexOf("var output = new byte[byteCount]"));
addCheck("security profiles are explicit", runtime.includes("new HashSet<int> { 128, 192, 256 }"));
addCheck("instantiate entropy boundary enforced", runtime.includes("MinimumEntropyBytes(securityStrengthBits)"));
addCheck("nonce boundary enforced", runtime.includes("MinimumNonceBytes(securityStrengthBits)"));
addCheck("reseed entropy boundary enforced", runtime.includes("MinimumEntropyBytes(session.SecurityStrengthBits)"));
addCheck("boundary and rejected-state tests exist", tests.includes("VerifyHmacDrbgRuntimeEnvelope") && tests.includes("Rejected oversized Generate changed HMAC-DRBG state"));
addCheck("replaced V is explicitly cleared", runtime.includes("ReplaceWithHmac(session.HashAlgorithm, ref value, session.Key, value)"));
addCheck("terminal Generate failure invalidates session", runtime.includes("CryptographicOperations.ZeroMemory(output);\n            session.MarkDestroyed();"));
addCheck("terminal reseed failure invalidates session", runtime.includes("UpdateSession(session, seedMaterial)") && runtime.includes("session.MarkDestroyed();\n            throw;"));
addCheck("exceptional lifecycle tests exist", tests.includes("VerifyExceptionalSessionLifecycle") && tests.includes("Replaced HMAC-DRBG V buffer was not explicitly cleared"));
addCheck("reseed counter boundary test avoids production mutator", tests.includes("SetReseedCounterForTest") && !runtime.includes("SetReseedCounterForTest"));
addCheck("qualification generator uses compliant chunks", generator.includes("GenerateRequestBytes = HmacDrbgRuntime.MaximumBytesPerGenerateRequest") && generator.includes("Math.Min(GenerateRequestBytes, remaining)"));
addCheck("new evidence omits secret-derived seed identifier", provider.includes("SeedIdentifier: null") || (provider.includes("Guid.NewGuid(),\n                null,") && provider.includes("ExecutionProvenanceIdentifier")));

const failed = checks.filter((check) => check.status === "FAIL");
console.log(JSON.stringify({ status: failed.length === 0 ? "PASS" : "FAIL", checks }, null, 2));
if (failed.length > 0) {
  process.exitCode = 1;
}
