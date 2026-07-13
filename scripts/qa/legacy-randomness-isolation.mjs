import { readFileSync } from "node:fs";

const checks = [];

function addCheck(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

const runtime = readFileSync("services/game-engine/src/GameEngine.Application/Services/CertifiedCsprngRuntimeServices.cs", "utf8");
const legacy = readFileSync("services/game-engine/src/GameEngine.Application/Services/RandomnessProviders.cs", "utf8");
const dryRun = readFileSync("services/game-engine/src/GameEngine.Application/Services/OutcomeDryRunPipeline.cs", "utf8");
const service = readFileSync("services/game-engine/src/GameEngine.Application/Services/OutcomeAuthorityHardeningService.cs", "utf8");
const tests = readFileSync("services/game-engine/tests/GameEngine.Application.Tests/Program.cs", "utf8");

addCheck("legacy isolation evidence model exists", service.includes("EvaluateLegacyRandomnessIsolation"));
addCheck("legacy/test randomness cannot be production eligible", service.includes("cannot be production eligible"));
addCheck("legacy/test randomness cannot register into CSPRNG runtime", service.includes("cannot be registered into the Certified CSPRNG runtime"));
addCheck("certified CSPRNG runtime has no System.Random use", !runtime.includes("new Random(") && !runtime.includes("Random.Shared"));
addCheck("certified CSPRNG runtime owns OS entropy path", runtime.includes("LinuxGetRandomEntropyProvider") && runtime.includes("WindowsBCryptEntropyProvider") && runtime.includes("MacOsSecRandomEntropyProvider"));
addCheck("dry-run deterministic randomness remains identifiable", dryRun.includes("new Random("));
addCheck("legacy placeholder randomness remains outside certified runtime", legacy.includes("DeterministicTestRandomnessProvider") || legacy.includes("Placeholder"));
addCheck("isolation behavior is tested", tests.includes("Legacy/test randomness must be isolated from production CSPRNG ownership"));

const failed = checks.filter((check) => check.status !== "PASS");
console.log(JSON.stringify({ status: failed.length === 0 ? "PASS" : "FAIL", checks }, null, 2));
if (failed.length > 0) {
  process.exitCode = 1;
}
