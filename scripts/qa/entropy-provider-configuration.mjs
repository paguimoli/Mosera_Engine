import { readFileSync } from "node:fs";

const checks = [];

function addCheck(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

const model = readFileSync("services/game-engine/src/GameEngine.Domain/Model/OutcomeAuthorityHardeningModels.cs", "utf8");
const service = readFileSync("services/game-engine/src/GameEngine.Application/Services/OutcomeAuthorityHardeningService.cs", "utf8");
const tests = readFileSync("services/game-engine/tests/GameEngine.Application.Tests/Program.cs", "utf8");

addCheck("explicit entropy deployment configuration model exists", model.includes("EntropyProviderDeploymentConfiguration"));
addCheck("exactly one provider is required", service.includes("Exactly one approved Entropy Provider must be configured"));
addCheck("provider id/version are explicit", model.includes("ProviderId") && model.includes("ProviderVersion"));
addCheck("runtime OS/provider compatibility is checked", service.includes("ExpectedPlatform") && service.includes("runtimeProvider.Platform"));
addCheck("fallback is explicitly disabled", service.includes("FallbackDisabled") && service.includes("fallbackDisabled"));
addCheck("provider substitution is detected", service.includes("ProviderSubstitutionDetected"));
addCheck("mismatch fails closed in tests", tests.includes("Entropy provider OS mismatch must fail closed"));

const failed = checks.filter((check) => check.status !== "PASS");
console.log(JSON.stringify({ status: failed.length === 0 ? "PASS" : "FAIL", checks }, null, 2));
if (failed.length > 0) {
  process.exitCode = 1;
}
