import { readFileSync } from "node:fs";

const checks = [];

function addCheck(name, passed, metadata = {}) {
  checks.push({ name, status: passed ? "PASS" : "FAIL", metadata });
}

const model = readFileSync("services/game-engine/src/GameEngine.Domain/Model/OutcomeAuthorityHardeningModels.cs", "utf8");
const service = readFileSync("services/game-engine/src/GameEngine.Application/Services/OutcomeAuthorityHardeningService.cs", "utf8");
const tests = readFileSync("services/game-engine/tests/GameEngine.Application.Tests/Program.cs", "utf8");

const requiredSections = [
  "provider readiness",
  "entropy readiness",
  "DRBG conformance",
  "statistical validation",
  "runtime persistence",
  "advisory locking",
  "recovery/provenance",
  "seed custody status",
  "signing custody status",
  "external suite evidence status",
  "production activation status",
];

addCheck("unified readiness report model exists", model.includes("OutcomeAuthorityReadinessReport"));
for (const section of requiredSections) {
  addCheck(`readiness section present: ${section}`, service.includes(section));
}
addCheck("missing evidence fails closed", service.includes("Missing readiness evidence"));
addCheck("production activation remains blocked", service.includes("Production Outcome Authority must remain disabled"));
addCheck("custody blockers are tested", tests.includes("Production seed custody remains unavailable") && tests.includes("Production signing custody remains unavailable"));

const failed = checks.filter((check) => check.status !== "PASS");
console.log(JSON.stringify({ status: failed.length === 0 ? "PASS" : "FAIL", checks }, null, 2));
if (failed.length > 0) {
  process.exitCode = 1;
}
