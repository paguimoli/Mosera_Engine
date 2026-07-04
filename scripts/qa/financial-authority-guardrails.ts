import {
  evaluateFinancialAuthorityGuardrail,
  readFinancialAuthorityCapabilityEvidenceFromEnv,
  summarizeFinancialAuthorityGuardrails,
} from "@/src/domains/financial-authority/financial-authority-guardrails";
import type { AuthorityDomainConfiguration } from "@/src/domains/authority-control/authority-control.types";

type Check = {
  name: string;
  status: "PASS";
};

const checks: Check[] = [];

function fail(message: string, metadata: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ status: "FAIL", message, ...metadata }, null, 2));
  process.exit(1);
}

function assert(condition: boolean, message: string, metadata: Record<string, unknown> = {}) {
  if (!condition) fail(message, metadata);
}

function pass(name: string) {
  checks.push({ name, status: "PASS" });
}

function config(authority: "MONOLITH" | "SERVICE"): AuthorityDomainConfiguration {
  return {
    domain: "LEDGER",
    authority,
    comparisonMode: "ENABLED",
    mismatchAlertThreshold: 0.001,
    serviceUrl: "http://ledger-service:8080",
  };
}

const monolith = evaluateFinancialAuthorityGuardrail({
  config: config("MONOLITH"),
});
assert(monolith.allowedToRun, "MONOLITH authority should remain allowed.", { monolith });
assert(!monolith.productionReady, "MONOLITH authority must not report production-ready service authority.", {
  monolith,
});
assert(monolith.productionStatus === "MONOLITH_ALLOWED", "MONOLITH authority should be explicitly classified.", {
  monolith,
});
assert(monolith.blockers.length === 0, "MONOLITH authority should not produce blockers.", { monolith });
pass("MONOLITH authority remains allowed");

const missingMutationCapability = evaluateFinancialAuthorityGuardrail({
  config: config("SERVICE"),
  serviceReachable: true,
  readinessHealthy: true,
  durablePersistenceConfigured: true,
  idempotencySupportConfigured: true,
  qaCapabilityMarkerPresent: true,
});
assert(
  missingMutationCapability.failClosed,
  "SERVICE authority without mutation capability should fail closed.",
  { missingMutationCapability }
);
assert(
  missingMutationCapability.productionStatus === "NOT_PRODUCTION_READY",
  "SERVICE authority without mutation capability should not be production-ready.",
  { missingMutationCapability }
);
assert(
  missingMutationCapability.blockers.some((blocker) => blocker.includes("mutation capability")),
  "SERVICE authority without mutation capability should report the blocker.",
  { missingMutationCapability }
);
pass("SERVICE authority without mutation capability fails closed");

const missingReadiness = evaluateFinancialAuthorityGuardrail({
  config: config("SERVICE"),
  serviceReachable: true,
  mutationCapabilityEnabled: true,
  durablePersistenceConfigured: true,
  idempotencySupportConfigured: true,
  qaCapabilityMarkerPresent: true,
});
assert(missingReadiness.failClosed, "SERVICE authority with missing readiness should fail closed.", {
  missingReadiness,
});
assert(
  missingReadiness.blockers.some((blocker) => blocker.includes("readiness endpoint")),
  "SERVICE authority with missing readiness should report the readiness blocker.",
  { missingReadiness }
);
pass("SERVICE authority with missing readiness fails closed");

const productionReadyService = evaluateFinancialAuthorityGuardrail({
  config: config("SERVICE"),
  serviceReachable: true,
  readinessHealthy: true,
  mutationCapabilityEnabled: true,
  durablePersistenceConfigured: true,
  idempotencySupportConfigured: true,
  qaCapabilityMarkerPresent: true,
});
assert(productionReadyService.productionReady, "SERVICE authority with all markers should be production-ready.", {
  productionReadyService,
});
assert(!productionReadyService.failClosed, "SERVICE authority with all markers should not fail closed.", {
  productionReadyService,
});
pass("SERVICE authority with all markers passes");

const evidence = readFinancialAuthorityCapabilityEvidenceFromEnv("LEDGER", {
  LEDGER_SERVICE_MUTATION_CAPABILITY: "ENABLED",
  LEDGER_SERVICE_DURABLE_PERSISTENCE: "ENABLED",
  LEDGER_SERVICE_IDEMPOTENCY_SUPPORT: "ENABLED",
  LEDGER_SERVICE_QA_CAPABILITY_MARKER: "local-qa",
});
assert(evidence.mutationCapabilityEnabled, "Capability evidence should read mutation marker.", { evidence });
assert(evidence.durablePersistenceConfigured, "Capability evidence should read durable persistence marker.", {
  evidence,
});
assert(evidence.idempotencySupportConfigured, "Capability evidence should read idempotency marker.", {
  evidence,
});
assert(evidence.qaCapabilityMarkerPresent, "Capability evidence should read QA marker.", { evidence });
pass("Capability evidence reads explicit markers");

const summary = summarizeFinancialAuthorityGuardrails([monolith]);
assert(summary.status === "PASS", "MONOLITH guardrail summary should pass local runtime.", { summary });
assert(!summary.productionReady, "MONOLITH guardrail summary must not report production-ready.", { summary });
pass("Runtime summary reports MONOLITH as allowed but not production-ready");

console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
