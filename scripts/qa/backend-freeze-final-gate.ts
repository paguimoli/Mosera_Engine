import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

type GateStep = {
  readonly name: string;
  readonly command: readonly string[];
};

type StepResult = {
  readonly name: string;
  readonly status: "PASS" | "FAIL";
  readonly durationMs: number;
};

const requiredDeferredItems = [
  "CSPRNG external validation",
  "NIST, TestU01, PractRand, and Dieharder",
  "Math Certification Pack",
  "External laboratory certification",
  "Penetration testing",
  "Senior engineering review",
  "Production-like staging",
  "Managed infrastructure",
  "External HSM/KMS and production key custody",
  "Official-results adapters",
  "UI/UX",
  "Dependency vulnerability remediation",
  "Stale external QA endpoints",
  "Advanced availability calendars",
  "Automated expiration cleanup",
  "Operational command console",
  "Multi-currency and FX",
  "Odds-format support",
  "Additional compensation strategies",
] as const;

const steps: readonly GateStep[] = [
  {
    name: "BF-7.1 authority ownership integrity",
    command: ["node", "scripts/run-ts-script.mjs", "scripts/qa/cross-authority-integrity.ts"],
  },
  {
    name: "BF-7.2 cross-service contract integrity",
    command: ["node", "scripts/run-ts-script.mjs", "scripts/qa/cross-service-contract-integrity.ts"],
  },
  {
    name: "BF-7.3 repository, worker, and SQL integrity",
    command: ["node", "scripts/run-ts-script.mjs", "scripts/qa/repository-worker-sql-consolidation.ts"],
  },
  {
    name: "production configuration fail-closed validation",
    command: ["node", "scripts/qa/production-config.mjs"],
  },
  {
    name: "dependency vulnerability gate",
    command: ["node", "scripts/operations/dependency-audit.mjs"],
  },
  {
    name: "migration manifest and deployed-schema validation",
    command: ["node", "scripts/migrations/validate-local-migrations.mjs"],
  },
  {
    name: "canonical integrated runtime",
    command: ["node", "scripts/qa/local-integrated-runtime.mjs"],
  },
] as const;

function fail(message: string, metadata: Record<string, unknown> = {}): never {
  console.error(JSON.stringify({
    status: "BACKEND_FREEZE_BLOCKED",
    message,
    ...metadata,
  }, null, 2));
  process.exit(1);
}

function runStep(step: GateStep): StepResult {
  const startedAt = Date.now();
  const [command, ...args] = step.command;
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const durationMs = Date.now() - startedAt;

  if (result.status !== 0) {
    fail(`${step.name} failed.`, {
      command: step.command.join(" "),
      exitCode: result.status,
      durationMs,
      stdout: result.stdout?.trim(),
      stderr: (result.stderr ?? result.error?.message)?.trim(),
    });
  }

  console.log(`PASS ${step.name} (${durationMs} ms)`);
  return { name: step.name, status: "PASS", durationMs };
}

async function validateDeferredRegister() {
  const register = await readFile(
    "docs/architecture/deferred-production-register.md",
    "utf8"
  );
  const missing = requiredDeferredItems.filter((item) => !register.includes(item));
  if (
    missing.length > 0 ||
    !register.includes("BF-7.4 Final Backend Freeze Deferrals") ||
    !register.includes("cannot become production authority")
  ) {
    fail("Deferred production register is incomplete or does not fail closed.", {
      missing,
    });
  }
}

async function validateReadiness() {
  const baseUrl = (
    process.env.APP_BASE_URL ??
    process.env.APP_URL ??
    "http://127.0.0.1:3000"
  ).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/api/health/ready`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as {
    status?: string;
    capabilities?: Record<string, boolean>;
    contractIntegrity?: {
      ready?: boolean;
      uniqueContracts?: boolean;
      uniqueEvents?: boolean;
      uniqueImplementations?: boolean;
      singleVersion?: boolean;
    };
  };
  const capabilities = payload.capabilities ?? {};
  const requiredCapabilities = [
    "backendFreezeRuntimeIntegrity",
    "coreAuthoritiesConsolidated",
    "crossAuthorityIntegrity",
    "crossServiceContractIntegrity",
    "repositoryWorkerSqlIntegrity",
    "operationalGovernanceAuthority",
    "operationalSecurityAuthority",
    "operationalChangeAuthority",
    "launchConfigurationFrozen",
  ];
  const failedCapabilities = requiredCapabilities.filter(
    (name) => capabilities[name] !== true
  );
  const contractIntegrity = payload.contractIntegrity;
  const contractReady = Boolean(
    contractIntegrity?.ready &&
      contractIntegrity.uniqueContracts &&
      contractIntegrity.uniqueEvents &&
      contractIntegrity.uniqueImplementations &&
      contractIntegrity.singleVersion
  );

  if (!response.ok || payload.status !== "ready" || failedCapabilities.length > 0 || !contractReady) {
    fail("Canonical runtime readiness is not Backend Freeze healthy.", {
      httpStatus: response.status,
      runtimeStatus: payload.status,
      failedCapabilities,
      contractIntegrity,
    });
  }
}

async function main() {
  if (!process.env.DATABASE_URL?.trim()) {
    fail("DATABASE_URL is required for the final Backend Freeze gate.");
  }

  await validateDeferredRegister();
  const results = steps.map(runStep);
  await validateReadiness();

  console.log(JSON.stringify({
    status: "BACKEND_FREEZE_PASS_WITH_DEFERRED_NONBLOCKERS",
    checkCount: results.length + 2,
    checks: [
      { name: "deferred blockers classified and fail-closed", status: "PASS" },
      ...results,
      { name: "canonical readiness aggregate healthy", status: "PASS" },
    ],
    productionActivation: "EXPLICIT_AND_FAIL_CLOSED",
    backendImplementation: "COMPLETE_FOR_FROZEN_SCOPE",
  }, null, 2));
}

main().catch((error) => {
  fail(
    error instanceof Error ? error.message : "Final Backend Freeze gate failed."
  );
});
