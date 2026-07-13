import { readFileSync } from "node:fs";

const checks = [];

function addCheck(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

const model = readFileSync("services/game-engine/src/GameEngine.Domain/Model/OutcomeAuthorityHardeningModels.cs", "utf8");
const service = readFileSync("services/game-engine/src/GameEngine.Application/Services/OutcomeAuthorityHardeningService.cs", "utf8");
const tests = readFileSync("services/game-engine/tests/GameEngine.Application.Tests/Program.cs", "utf8");

addCheck("restart recovery harness plan model exists", model.includes("ProcessRestartRecoveryHarnessPlan"));
addCheck("harness supports lock acquisition checkpoint", service.includes("OutcomeRuntimeCrashInjectionStage.LockAcquisition"));
addCheck("harness verifies durable idempotency", service.includes("claim request with durable idempotency key"));
addCheck("harness verifies lock release/replay", service.includes("replay same idempotency key"));
addCheck("harness verifies no duplicate certificates/receipts", service.includes("no duplicate outcome/certificate/receipt"));
addCheck("container kill requires explicit approval", service.includes("RequiresContainerKillApproval: true"));
addCheck("harness remains non-production", service.includes("ProductionAuthorityDisabled: true"));
addCheck("harness plan is tested", tests.includes("Process restart harness plan must cover lock/idempotency recovery"));

const failed = checks.filter((check) => check.status !== "PASS");
console.log(JSON.stringify({ status: failed.length === 0 ? "PASS" : "FAIL", checks }, null, 2));
if (failed.length > 0) {
  process.exitCode = 1;
}
